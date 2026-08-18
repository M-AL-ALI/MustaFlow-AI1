import { describe, expect, it, vi } from "vitest";
import type { PoolClient } from "pg";
import { projectsTable } from "@workspace/db";
import { createEncryptionService, isEncryptedValue } from "../encryption";
import {
  applyProjectOwnerSchemaHardening,
  backfillStoredIntegrationCredentials,
} from "../startup-migrations";

vi.hoisted(() => {
  process.env.DATABASE_URL = "postgresql://test:test@127.0.0.1:1/test";
  process.env.ENCRYPTION_KEY = Buffer.alloc(32, 19).toString("base64");
});

const service = createEncryptionService(Buffer.alloc(32, 19).toString("base64"));

class CredentialMigrationClient {
  readonly statements: string[] = [];
  readonly mcpRows = new Map<number, string>();
  readonly domainRows = new Map<number, string>();

  async query(text: string, params: unknown[] = []) {
    this.statements.push(text);
    if (/SELECT id, auth_header/i.test(text)) {
      return {
        rows: [...this.mcpRows.entries()].map(([id, auth_header]) => ({ id, auth_header })),
        rowCount: null,
      };
    }
    if (/SELECT id, transfer_auth_code/i.test(text)) {
      return {
        rows: [...this.domainRows.entries()].map(([id, transfer_auth_code]) => ({
          id,
          transfer_auth_code,
        })),
        rowCount: null,
      };
    }
    if (/UPDATE mcp_servers/i.test(text)) {
      const [encrypted, id, expected] = params as [string, number, string];
      if (this.mcpRows.get(id) !== expected) return { rows: [], rowCount: 0 };
      this.mcpRows.set(id, encrypted);
      return { rows: [], rowCount: 1 };
    }
    if (/UPDATE purchased_domains/i.test(text)) {
      const [encrypted, id, expected] = params as [string, number, string];
      if (this.domainRows.get(id) !== expected) return { rows: [], rowCount: 0 };
      this.domainRows.set(id, encrypted);
      return { rows: [], rowCount: 1 };
    }
    return { rows: [], rowCount: null };
  }
}

function migrationClient(client: CredentialMigrationClient) {
  return client as unknown as Pick<PoolClient, "query">;
}

describe("stored integration credential encryption", () => {
  it.each([
    ["mcp_servers.auth_header", "Bearer integration-header"],
    ["purchased_domains.transfer_auth_code", "domain-transfer-value"],
  ])("round-trips %s with the platform ciphertext envelope", (_column, plaintext) => {
    const encrypted = service.encrypt(plaintext);
    expect(isEncryptedValue(encrypted)).toBe(true);
    expect(encrypted).not.toContain(plaintext);
    expect(service.decrypt(encrypted)).toBe(plaintext);
  });

  it("backfills plaintext once and leaves the second run byte-identical", async () => {
    const client = new CredentialMigrationClient();
    client.mcpRows.set(11, "Bearer legacy-header");
    client.domainRows.set(22, "legacy-transfer-value");
    client.mcpRows.set(12, service.encrypt("already-encrypted-header"));
    client.domainRows.set(23, service.encrypt("already-encrypted-domain-value"));

    const first = await backfillStoredIntegrationCredentials(migrationClient(client), service);
    const afterFirst = {
      mcp: [...client.mcpRows.entries()],
      domains: [...client.domainRows.entries()],
    };
    const second = await backfillStoredIntegrationCredentials(migrationClient(client), service);

    expect(first).toEqual({
      mcpServersEncrypted: 1,
      purchasedDomainsEncrypted: 1,
      skippedBecauseEncryptionUnavailable: false,
    });
    expect(second).toEqual({
      mcpServersEncrypted: 0,
      purchasedDomainsEncrypted: 0,
      skippedBecauseEncryptionUnavailable: false,
    });
    expect({
      mcp: [...client.mcpRows.entries()],
      domains: [...client.domainRows.entries()],
    }).toEqual(afterFirst);
    expect(service.decrypt(client.mcpRows.get(11)!)).toBe("Bearer legacy-header");
    expect(service.decrypt(client.domainRows.get(22)!)).toBe("legacy-transfer-value");
  });
});

describe("project owner schema hardening", () => {
  it("drops the shared default, creates the ownership indexes, and rejects an ownerless insert", async () => {
    let ownerDefaultPresent = true;
    const statements: string[] = [];
    const client = {
      async query(text: string) {
        statements.push(text);
        if (/ALTER TABLE projects ALTER COLUMN owner_id DROP DEFAULT/i.test(text)) {
          ownerDefaultPresent = false;
          return { rows: [], rowCount: null };
        }
        if (/INSERT INTO projects/i.test(text) && !ownerDefaultPresent) {
          const error = new Error("null value in column owner_id violates not-null constraint");
          Object.assign(error, { code: "23502" });
          throw error;
        }
        return { rows: [], rowCount: null };
      },
    } as unknown as Pick<PoolClient, "query">;

    await applyProjectOwnerSchemaHardening(client);

    expect(projectsTable.ownerId.hasDefault).toBe(false);
    await expect(
      client.query("INSERT INTO projects (name) VALUES ('ownerless')"),
    ).rejects.toMatchObject({ code: "23502" });
    expect(statements.join("\n")).toContain("workspaces_owner_user_idx");
    expect(statements.join("\n")).toContain("projects_owner_idx");
    expect(statements.join("\n")).toContain("projects_workspace_idx");
  });
});

import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const source = readFileSync(new URL("./project-collaboration.ts", import.meta.url), "utf8");
const authSource = readFileSync(new URL("../lib/auth.ts", import.meta.url), "utf8");
const multiplayerSource = readFileSync(new URL("../lib/multiplayer.ts", import.meta.url), "utf8");

describe("project collaboration contract", () => {
  it("guards every management mutation with owner-level project access", () => {
    expect(source).toMatch(/"\/projects\/:id\/invites"\s*,\s*requireProjectAccess\("owner"\)/u);
    expect(source).toMatch(
      /"\/projects\/:id\/invites\/:inviteId\/revoke"\s*,\s*requireProjectAccess\("owner"\)/u,
    );
    expect(source).toMatch(
      /"\/projects\/:id\/members\/:userId"\s*,\s*requireProjectAccess\("owner"\)/u,
    );
  });

  it("stores only a digest, claims an invitation atomically, and never widens workspace access", () => {
    expect(source).toContain('createHash("sha256")');
    expect(source).toContain("tokenHash: tokenDigest(token)");
    expect(source).toMatch(
      /eq\(projectInvitesTable\.status, "pending"\)[\s\S]*gt\(projectInvitesTable\.expiresAt/u,
    );
    expect(source).toContain("if (!claimed) return false");
    expect(source).not.toContain("workspaceMembersTable");
    expect(source).not.toMatch(/metadata:\s*\{[^}]*token/u);
  });

  it("retires expired pending invitations before issuing a replacement", () => {
    expect(source).toContain('set({ status: "expired" })');
    expect(source).toContain("lte(projectInvitesTable.expiresAt, new Date())");
  });

  it("makes project roles authoritative in the central access predicate and list scope", () => {
    expect(authSource).toContain("projectCollaboratorsTable");
    expect(authSource).toContain("collaboratorRoleMeets(collaborator.role, minRole)");
    expect(authSource).toContain("collaboratorRows");
  });

  it("disconnects a removed collaborator instead of leaving ghost presence", () => {
    expect(multiplayerSource).toContain('type: "access_removed"');
    expect(multiplayerSource).toContain("clearInterval(collaboratorWatch)");
    expect(multiplayerSource).toContain('checkProjectAccess(peer.userId, projectId, "viewer")');
  });
});

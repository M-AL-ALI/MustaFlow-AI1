import { describe, expect, it, vi } from "vitest";
import { PgDialect } from "drizzle-orm/pg-core";
import { pageMapSnapshotPredicate } from "./page-map-repository";

vi.mock("@workspace/db", async () => ({ ...(await import("@workspace/db/schema")), db: {} }));
describe("Page Map SQL snapshot predicate shape (no database execution)", () => {
  it.each([null, undefined])("normalizes both empty-map storage representations: %s", (value) => {
    const query = new PgDialect().sqlToQuery(pageMapSnapshotPredicate(value));
    expect(query.sql).toContain("coalesce(");
    expect(query.sql).toContain("'null'::jsonb)");
    expect(query.params).toEqual(["null"]);
    expect(query.sql).not.toMatch(/is null/i);
  });
  it("uses a parameterized JSONB equality check for a populated snapshot", () => {
    const snapshot = { web: { nodes: [], edges: [] } };
    const query = new PgDialect().sqlToQuery(pageMapSnapshotPredicate(snapshot));
    expect(query.sql).toContain("= $1::jsonb");
    expect(query.params).toEqual([JSON.stringify(snapshot)]);
  });
});

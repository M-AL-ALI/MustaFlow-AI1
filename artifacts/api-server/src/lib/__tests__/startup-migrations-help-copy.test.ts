process.env.DATABASE_URL = process.env.DATABASE_URL ?? "postgres://noop@localhost:5432/noop";

import { describe, expect, it, vi } from "vitest";

vi.mock("@workspace/db", async () => {
  const { HELP_ARTICLE_SEED } = await import("../../../../../lib/db/src/help-center-seed");
  return {
    HELP_ARTICLE_SEED,
    pool: { connect: vi.fn() },
  };
});

const { HELP_ARTICLE_SEED } = await import("../../../../../lib/db/src/help-center-seed");
const { refreshBillingCreditsHelpArticle } = await import("../startup-migrations");

describe("BC-2 billing help copy migration", () => {
  it("updates only billing-credits from the shared seed and is idempotent", async () => {
    const article = HELP_ARTICLE_SEED.find((entry) => entry.slug === "billing-credits");
    expect(article).toBeDefined();

    let storedBody = "New accounts start with a credit balance.";
    let writes = 0;
    const query = vi.fn(async (sql: string, params?: unknown[]) => {
      expect(sql).toContain("UPDATE help_articles");
      expect(sql).toContain("WHERE slug = $2");
      expect(sql).toContain("body IS DISTINCT FROM $1");
      expect(params).toEqual([article!.body, "billing-credits"]);

      if (storedBody !== params![0]) {
        storedBody = String(params![0]);
        writes += 1;
        return { rowCount: 1 };
      }
      return { rowCount: 0 };
    });
    const client = { query } as unknown as Parameters<typeof refreshBillingCreditsHelpArticle>[0];

    await refreshBillingCreditsHelpArticle(client);
    expect(storedBody).toBe(article!.body);
    expect(storedBody).not.toContain("New accounts start with a credit balance");

    await refreshBillingCreditsHelpArticle(client);
    expect(query).toHaveBeenCalledTimes(2);
    expect(writes).toBe(1);
  });
});

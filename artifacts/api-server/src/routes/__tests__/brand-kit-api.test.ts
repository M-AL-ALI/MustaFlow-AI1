import { describe, it, expect, vi, beforeEach } from "vitest";

const mockBrandKitRow = {
  id: 1,
  userId: "user_test123",
  primaryColor: "#1a1a2e",
  accentColor: "#e94560",
  headingFont: "Arial",
  bodyFont: "Arial",
  logoAssetId: null,
  updatedAt: new Date(),
};

vi.mock("@workspace/db", () => {
  const makeChain = (rows: unknown[]) => ({
    from: vi.fn().mockReturnValue({
      where: vi.fn().mockResolvedValue(rows),
    }),
  });
  return {
    db: {
      select: vi.fn().mockImplementation(() => makeChain([mockBrandKitRow])),
      insert: vi.fn().mockReturnValue({
        values: vi.fn().mockReturnValue({
          onConflictDoUpdate: vi.fn().mockResolvedValue([mockBrandKitRow]),
        }),
      }),
      delete: vi.fn().mockReturnValue({
        where: vi.fn().mockResolvedValue([]),
      }),
    },
    oraBrandKits: {
      userId: "userId",
      primaryColor: "primaryColor",
      accentColor: "accentColor",
      headingFont: "headingFont",
      bodyFont: "bodyFont",
      logoAssetId: "logoAssetId",
    },
    eq: vi.fn().mockReturnValue({ _tag: "eq" }),
  };
});

vi.mock("../../lib/ora-assets", () => ({
  getOraAssetMeta: vi.fn().mockResolvedValue(null),
  persistOraAsset: vi.fn().mockResolvedValue(42),
}));

describe("loadBrandKit helper", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("returns a BrandKit when DB has a matching row", async () => {
    const { db } = await import("@workspace/db");
    vi.mocked(db.select).mockReturnValue({
      from: vi.fn().mockReturnValue({
        where: vi.fn().mockResolvedValue([mockBrandKitRow]),
      }),
    } as never);

    const { loadBrandKit } = await import("../../lib/brand-kit-loader");
    const kit = await loadBrandKit("user_test123", null);
    expect(kit).not.toBeNull();
    expect(kit!.primaryColor).toBe("#1a1a2e");
    expect(kit!.accentColor).toBe("#e94560");
    expect(kit!.headingFont).toBe("Arial");
    expect(kit!.bodyFont).toBe("Arial");
    expect(kit!.logoBuf).toBeNull();
  });

  it("returns null when DB has no row for the user", async () => {
    const { db } = await import("@workspace/db");
    vi.mocked(db.select).mockReturnValue({
      from: vi.fn().mockReturnValue({
        where: vi.fn().mockResolvedValue([]),
      }),
    } as never);

    const { loadBrandKit } = await import("../../lib/brand-kit-loader");
    const kit = await loadBrandKit("user_no_kit", null);
    expect(kit).toBeNull();
  });
});

describe("oraBrandKit router", () => {
  it("exports a function (Express router) as default", async () => {
    const mod = await import("../ora-brand-kit");
    const router = mod.default;
    expect(typeof router).toBe("function");
  });
});

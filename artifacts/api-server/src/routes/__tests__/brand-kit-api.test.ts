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

const MOCK_SAFE_FONTS = [
  "Calibri",
  "Arial",
  "Georgia",
  "Times New Roman",
  "Trebuchet MS",
  "Helvetica",
  "Verdana",
] as const;

vi.mock("@workspace/db", () => {
  const makeChain = (rows: unknown[]) => ({
    from: vi.fn().mockReturnValue({
      where: vi.fn().mockReturnValue({
        limit: vi.fn().mockResolvedValue(rows),
      }),
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
    brandKitsTable: {
      id: "id",
      userId: "user_id",
      oraProjectId: "ora_project_id",
      logoAssetId: "logo_asset_id",
      primaryColor: "primary_color",
      secondaryColor: "secondary_color",
      accentColor: "accent_color",
      headingFont: "heading_font",
      bodyFont: "body_font",
      createdAt: "created_at",
      updatedAt: "updated_at",
    },
    oraAssetsTable: {
      id: "id",
      userId: "user_id",
      kind: "kind",
      deletedAt: "deleted_at",
      fileName: "file_name",
      mimeType: "mime_type",
    },
    SAFE_FONTS: MOCK_SAFE_FONTS,
    eq: vi.fn().mockReturnValue({ _tag: "eq" }),
    and: vi.fn().mockReturnValue({ _tag: "and" }),
    isNull: vi.fn().mockReturnValue({ _tag: "isNull" }),
  };
});

vi.mock("../../lib/ora-assets", () => ({
  getOraAssetMeta: vi.fn().mockResolvedValue(null),
  getOraAssetBytes: vi.fn().mockResolvedValue(null),
  persistOraAsset: vi.fn().mockResolvedValue(42),
}));

describe("loadBrandKit helper", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("returns a BrandKit when DB has a matching row", async () => {
    const { db } = await import("@workspace/db");
    vi.mocked(db.select).mockImplementation(() => ({
      from: vi.fn().mockReturnValue({
        where: vi.fn().mockReturnValue({
          limit: vi.fn().mockResolvedValue([mockBrandKitRow]),
        }),
      }),
    }) as never);

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
    vi.mocked(db.select).mockImplementation(() => ({
      from: vi.fn().mockReturnValue({
        where: vi.fn().mockReturnValue({
          limit: vi.fn().mockResolvedValue([]),
        }),
      }),
    }) as never);

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

import { describe, it, expect, vi, beforeEach } from "vitest";
import express from "express";
import request from "supertest";

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
      update: vi.fn().mockReturnValue({
        set: vi.fn().mockReturnValue({
          where: vi.fn().mockResolvedValue([mockBrandKitRow]),
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

vi.mock("../../lib/logger", () => ({
  logger: { error: vi.fn(), warn: vi.fn(), info: vi.fn(), debug: vi.fn() },
}));

function buildTestApp() {
  const app = express();
  app.use(express.json());
  app.use((req, _res, next) => {
    (req as unknown as Record<string, unknown>).userId = "user_test123";
    next();
  });
  return app;
}

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

describe("GET /ora/brand-kit response shape", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("returns { kit: { primaryColor, accentColor, ... } } when a kit exists", async () => {
    const { db } = await import("@workspace/db");
    vi.mocked(db.select).mockImplementation(() => ({
      from: vi.fn().mockReturnValue({
        where: vi.fn().mockReturnValue({
          limit: vi.fn().mockResolvedValue([mockBrandKitRow]),
        }),
      }),
    }) as never);

    const { default: router } = await import("../ora-brand-kit");
    const app = buildTestApp();
    app.use(router);

    const res = await request(app).get("/ora/brand-kit");
    expect(res.status).toBe(200);
    expect(res.body).toHaveProperty("kit");
    const kit = res.body.kit as Record<string, unknown>;
    expect(kit).not.toBeNull();
    expect(kit.primaryColor).toBe("#1a1a2e");
    expect(kit.accentColor).toBe("#e94560");
    expect(kit.headingFont).toBe("Arial");
  });

  it("returns { kit: null } when no row exists for the user", async () => {
    const { db } = await import("@workspace/db");
    vi.mocked(db.select).mockImplementation(() => ({
      from: vi.fn().mockReturnValue({
        where: vi.fn().mockReturnValue({
          limit: vi.fn().mockResolvedValue([]),
        }),
      }),
    }) as never);

    const { default: router } = await import("../ora-brand-kit");
    const app = buildTestApp();
    app.use(router);

    const res = await request(app).get("/ora/brand-kit");
    expect(res.status).toBe(200);
    expect(res.body).toHaveProperty("kit");
    expect(res.body.kit).toBeNull();
  });

  it("kit.logoPreviewUrl is set when logoAssetId is present", async () => {
    const { db } = await import("@workspace/db");
    vi.mocked(db.select).mockImplementation(() => ({
      from: vi.fn().mockReturnValue({
        where: vi.fn().mockReturnValue({
          limit: vi.fn().mockResolvedValue([{ ...mockBrandKitRow, logoAssetId: 7 }]),
        }),
      }),
    }) as never);

    const { default: router } = await import("../ora-brand-kit");
    const app = buildTestApp();
    app.use(router);

    const res = await request(app).get("/ora/brand-kit");
    expect(res.status).toBe(200);
    const kit = res.body.kit as Record<string, unknown>;
    expect(kit.logoAssetId).toBe(7);
    expect(typeof kit.logoPreviewUrl).toBe("string");
    expect((kit.logoPreviewUrl as string).length).toBeGreaterThan(0);
  });

  it("does NOT return a flat primaryColor at the root level", async () => {
    const { db } = await import("@workspace/db");
    vi.mocked(db.select).mockImplementation(() => ({
      from: vi.fn().mockReturnValue({
        where: vi.fn().mockReturnValue({
          limit: vi.fn().mockResolvedValue([mockBrandKitRow]),
        }),
      }),
    }) as never);

    const { default: router } = await import("../ora-brand-kit");
    const app = buildTestApp();
    app.use(router);

    const res = await request(app).get("/ora/brand-kit");
    expect(res.status).toBe(200);
    expect(res.body).not.toHaveProperty("primaryColor");
    expect(res.body).not.toHaveProperty("logoUrl");
  });
});

describe("PUT /ora/brand-kit validation", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("rejects an invalid hex color with 400", async () => {
    const { default: router } = await import("../ora-brand-kit");
    const app = buildTestApp();
    app.use(router);

    const res = await request(app)
      .put("/ora/brand-kit")
      .send({ primaryColor: "not-a-color" });
    expect(res.status).toBe(400);
    expect(res.body).toHaveProperty("error");
  });

  it("rejects a font not in SAFE_FONTS with 400", async () => {
    const { default: router } = await import("../ora-brand-kit");
    const app = buildTestApp();
    app.use(router);

    const res = await request(app)
      .put("/ora/brand-kit")
      .send({ headingFont: "Comic Sans MS" });
    expect(res.status).toBe(400);
  });
});

describe("POST /ora/brand-kit/logo mime-type gate", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("rejects image/webp with 400", async () => {
    const { default: router } = await import("../ora-brand-kit");
    const app = buildTestApp();
    app.use(router);

    const res = await request(app)
      .post("/ora/brand-kit/logo")
      .send({ data: "abc123", mimeType: "image/webp", fileName: "logo.webp" });
    expect(res.status).toBe(400);
  });

  it("rejects image/gif with 400", async () => {
    const { default: router } = await import("../ora-brand-kit");
    const app = buildTestApp();
    app.use(router);

    const res = await request(app)
      .post("/ora/brand-kit/logo")
      .send({ data: "abc123", mimeType: "image/gif", fileName: "logo.gif" });
    expect(res.status).toBe(400);
  });

  it("rejects image/svg+xml with 400", async () => {
    const { default: router } = await import("../ora-brand-kit");
    const app = buildTestApp();
    app.use(router);

    const res = await request(app)
      .post("/ora/brand-kit/logo")
      .send({ data: "abc123", mimeType: "image/svg+xml", fileName: "logo.svg" });
    expect(res.status).toBe(400);
  });

  it("accepts image/png and returns { assetId, previewUrl }", async () => {
    const { persistOraAsset } = await import("../../lib/ora-assets");
    vi.mocked(persistOraAsset).mockResolvedValue(42);

    const { default: router } = await import("../ora-brand-kit");
    const app = buildTestApp();
    app.use(router);

    const validPngB64 = Buffer.from("fake-png-bytes").toString("base64");
    const res = await request(app)
      .post("/ora/brand-kit/logo")
      .send({ data: validPngB64, mimeType: "image/png", fileName: "logo.png" });
    expect(res.status).toBe(200);
    expect(res.body).toHaveProperty("assetId");
    expect(res.body).toHaveProperty("previewUrl");
  });

  it("accepts image/jpeg and returns { assetId, previewUrl }", async () => {
    const { persistOraAsset } = await import("../../lib/ora-assets");
    vi.mocked(persistOraAsset).mockResolvedValue(99);

    const { default: router } = await import("../ora-brand-kit");
    const app = buildTestApp();
    app.use(router);

    const validJpegB64 = Buffer.from("fake-jpeg-bytes").toString("base64");
    const res = await request(app)
      .post("/ora/brand-kit/logo")
      .send({ data: validJpegB64, mimeType: "image/jpeg", fileName: "logo.jpg" });
    expect(res.status).toBe(200);
    expect(res.body).toHaveProperty("assetId");
    expect(res.body).toHaveProperty("previewUrl");
    expect((res.body.previewUrl as string).length).toBeGreaterThan(0);
  });
});

describe("oraBrandKit router", () => {
  it("exports a function (Express router) as default", async () => {
    const mod = await import("../ora-brand-kit");
    const router = mod.default;
    expect(typeof router).toBe("function");
  });
});

describe("brand-kit migration index parity", () => {
  it("startup-migrations.ts and migrate-brand-kits.ts define the same Brand Kit unique indexes", async () => {
    const fs = await import("fs");
    const path = await import("path");
    const dir = path.dirname(new URL(import.meta.url).pathname);

    const startupText = fs.readFileSync(
      path.resolve(dir, "../../lib/startup-migrations.ts"),
      "utf8",
    );
    const standaloneText = fs.readFileSync(
      path.resolve(dir, "../../../../../scripts/src/migrate-brand-kits.ts"),
      "utf8",
    );

    const requiredIndexes = [
      "brand_kits_user_personal_idx",
      "brand_kits_user_project_idx",
      "brand_kits_user_id_idx",
    ] as const;

    for (const idx of requiredIndexes) {
      expect(startupText).toContain(idx);
      expect(standaloneText).toContain(idx);
    }

    for (const src of [startupText, standaloneText]) {
      const personalBlock = src.slice(
        src.indexOf("brand_kits_user_personal_idx"),
        src.indexOf("brand_kits_user_personal_idx") + 200,
      );
      expect(personalBlock.toLowerCase()).toContain("unique");
      expect(personalBlock).toContain("ora_project_id IS NULL");

      const projectBlock = src.slice(
        src.indexOf("brand_kits_user_project_idx"),
        src.indexOf("brand_kits_user_project_idx") + 200,
      );
      expect(projectBlock.toLowerCase()).toContain("unique");
      expect(projectBlock).toContain("ora_project_id IS NOT NULL");
    }
  });
});

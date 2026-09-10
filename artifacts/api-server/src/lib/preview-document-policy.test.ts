import express from "express";
import request from "supertest";
import { describe, expect, it } from "vitest";
import { previewDocumentCsp, protectPreviewDocument } from "./preview-document-policy";

describe("API preview document response policy", () => {
  it.each([undefined, "default-src 'self'", ["script-src 'none'", "sandbox allow-same-origin"]])(
    "adds an enforced opaque sandbox without replacing existing restrictions: %j",
    (existing) => {
      const policies = previewDocumentCsp(existing);
      expect(policies).toContain("sandbox allow-scripts allow-forms allow-popups");
      if (existing)
        expect(policies).toEqual(
          expect.arrayContaining(Array.isArray(existing) ? existing : [existing]),
        );
      expect(previewDocumentCsp(policies)).toEqual(policies);
    },
  );

  it("puts the policy on the real HTTP document response, not report-only or HTML metadata", async () => {
    const app = express();
    app.get("/preview", (_req, res) => {
      res.setHeader("Content-Security-Policy", "frame-ancestors 'self'");
      protectPreviewDocument(res);
      res.type("html").send("<!doctype html><button>Working preview</button>");
    });
    const response = await request(app).get("/preview").expect(200);
    expect(response.headers["content-security-policy"]).toContain("frame-ancestors 'self'");
    expect(response.headers["content-security-policy"]).toContain(
      "sandbox allow-scripts allow-forms allow-popups",
    );
    expect(response.headers["content-security-policy-report-only"]).toBeUndefined();
    expect(response.headers["referrer-policy"]).toBe("no-referrer");
    expect(response.headers["x-content-type-options"]).toBe("nosniff");
    expect(response.text).toContain("Working preview");
  });
});

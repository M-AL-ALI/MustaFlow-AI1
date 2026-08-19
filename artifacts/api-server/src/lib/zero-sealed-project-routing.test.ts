import { describe, expect, it } from "vitest";
import {
  ZERO_SEALED_PROJECT_TYPE_INCOMPATIBLE,
  ZERO_SEALED_PROJECT_TYPE_MESSAGE,
  ZERO_SEALED_PROJECT_TYPE_RECOVERY,
  ZERO_SEALED_PROJECT_TYPE_SUGGESTIONS,
  resolveZeroSealedProjectRouting,
} from "./zero-sealed-project-routing";

describe("sealed production project routing", () => {
  it.each([
    ["react-vite", "react-vite"],
    ["static-html", "static-html"],
  ])("routes a plain %s website through the Node production source contract", (stack, format) => {
    expect(
      resolveZeroSealedProjectRouting({
        projectKind: "web",
        platform: "web",
        stack,
        projectFormat: format,
        isMobile: false,
      }),
    ).toEqual({
      eligible: true,
      reason: "convertible_website",
      stack: "node-api",
      projectFormat: "static-html",
      changed: true,
    });
  });

  it("keeps a native Node website on the canonical production route", () => {
    expect(
      resolveZeroSealedProjectRouting({
        projectKind: "web",
        platform: "web",
        stack: "node-api",
        projectFormat: "static-html",
        isMobile: false,
      }),
    ).toEqual({
      eligible: true,
      reason: "native_node_application",
      stack: "node-api",
      projectFormat: "static-html",
      changed: false,
    });
  });

  it.each([
    ["mobile-cross", "cross", "react-vite", true, "mobile_project"],
    ["slides", "web", "slides", false, "unsupported_project_kind"],
    ["web", "web", "nextjs", false, "unsupported_web_stack"],
    ["api", "server", "node-api", false, "unsupported_project_kind"],
  ])(
    "keeps unsupported project kind %s closed with a typed reason",
    (projectKind, platform, stack, isMobile, reason) => {
      expect(
        resolveZeroSealedProjectRouting({
          projectKind,
          platform,
          stack,
          projectFormat: "static-html",
          isMobile,
        }),
      ).toEqual({ eligible: false, reason });
    },
  );

  it("keeps the incompatible response typed, plain, and directly recoverable", () => {
    expect(ZERO_SEALED_PROJECT_TYPE_INCOMPATIBLE).toBe("zero_sealed_project_type_incompatible");
    expect(ZERO_SEALED_PROJECT_TYPE_MESSAGE).toBe(
      "This website needs to be converted to the supported production format before it can build.",
    );
    expect(ZERO_SEALED_PROJECT_TYPE_RECOVERY.label).toBe("Convert and build");
    expect(ZERO_SEALED_PROJECT_TYPE_SUGGESTIONS).toHaveLength(1);
    expect(
      [
        ZERO_SEALED_PROJECT_TYPE_MESSAGE,
        ZERO_SEALED_PROJECT_TYPE_RECOVERY.label,
        ZERO_SEALED_PROJECT_TYPE_RECOVERY.prompt,
        ...ZERO_SEALED_PROJECT_TYPE_SUGGESTIONS,
      ].join(" "),
    ).not.toMatch(/sealed|zero|node api|vite|stack|runtime|manifest/iu);
  });
});

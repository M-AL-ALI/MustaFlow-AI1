import { describe, expect, it } from "vitest";
import {
  buildOraImageEditProfile,
  buildOraImageGenerationProfile,
  inferOraImagePromptKind,
} from "../image-quality";

describe("Ora image quality profiles", () => {
  it("classifies common image requests", () => {
    expect(inferOraImagePromptKind("create a logo for my bakery")).toBe("logo");
    expect(inferOraImagePromptKind("make a YouTube thumbnail for my tutorial")).toBe("banner");
    expect(inferOraImagePromptKind("draw a poster for a summer event")).toBe("poster");
    expect(inferOraImagePromptKind("realistic product photo of a sneaker")).toBe("product");
  });

  it("uses plan-aware quality and inferred layout for generated images", () => {
    const waveBanner = buildOraImageGenerationProfile({
      prompt: "create a hero banner for a cloud accounting app",
      subscriptionTier: "wave",
    });

    expect(waveBanner.planTier).toBe("wave");
    expect(waveBanner.kind).toBe("banner");
    expect(waveBanner.aspectRatio).toBe("16:9");
    expect(waveBanner.quality).toBe("high");
    expect(waveBanner.prompt).toContain("production-ready");
    expect(waveBanner.prompt).toContain("User request: create a hero banner");

    const freeLogo = buildOraImageGenerationProfile({
      prompt: "create a logo for my mobile mechanic app",
      subscriptionTier: "free",
    });

    expect(freeLogo.kind).toBe("logo");
    expect(freeLogo.aspectRatio).toBe("1:1");
    expect(freeLogo.style).toBe("natural");
    expect(freeLogo.quality).toBe("standard");
    expect(freeLogo.prompt).toContain("simple brandable mark");
  });

  it("builds Ora-only edit instructions while preserving the original text", () => {
    const profile = buildOraImageEditProfile({
      instruction: "make the sky sunset orange",
      subscriptionTier: "core",
    });

    expect(profile.planTier).toBe("core");
    expect(profile.quality).toBe("high");
    expect(profile.originalInstruction).toBe("make the sky sunset orange");
    expect(profile.instruction).toContain("Edit instruction: make the sky sunset orange");
    expect(profile.instruction).toContain("Preserve the original image identity");
    expect(profile.instruction).toContain("matching lighting");
  });
});

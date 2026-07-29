import { describe, expect, it } from "vitest";
import {
  mergeProjectImageItems,
  parseZeroGeneratedImageEvent,
  projectFileToImageItem,
  projectImageAssetUrl,
  studioImageToItem,
  studioInsertPath,
} from "./project-image-model";

describe("project image model", () => {
  it("turns Zero's existing generate_image event into a project gallery item", () => {
    expect(
      parseZeroGeneratedImageEvent(45, {
        id: 12,
        taskId: 123,
        eventType: "generate_image",
        message: JSON.stringify({
          tool: "generate_image",
          path: "assets/hero image.png",
          mimeType: "image/png",
          previewDataUri: null,
        }),
        createdAt: "2026-07-28T18:00:00.000Z",
      }),
    ).toMatchObject({
      key: "asset:assets/hero image.png",
      source: "zero",
      status: "completed",
      imageUrl: "/api/projects/45/preview/assets/hero%20image.png",
      path: "assets/hero image.png",
    });
  });

  it("maps persisted image files and Image Studio rows without changing their contracts", () => {
    expect(
      projectFileToImageItem(7, {
        id: 2,
        path: "public/brand-mark.webp",
        mimeType: "image/webp",
        updatedAt: "2026-07-28T17:00:00.000Z",
      }),
    ).toMatchObject({
      key: "asset:public/brand-mark.webp",
      source: "project",
      imageUrl: "/api/projects/7/preview/public/brand-mark.webp",
    });
    expect(
      studioImageToItem({
        id: 91,
        prompt: "A quiet mountain sunrise",
        quality: "standard",
        aspectRatio: "16:9",
        status: "generating",
        createdAt: "2026-07-28T18:00:00.000Z",
      }),
    ).toMatchObject({
      key: "studio:91",
      source: "studio",
      status: "generating",
    });
    expect(studioInsertPath(91)).toBe("assets/generated/image-studio-91.webp");
    expect(projectImageAssetUrl(7, "assets/a b.png")).toBe(
      "/api/projects/7/preview/assets/a%20b.png",
    );
  });

  it("deduplicates project files when a richer Zero event describes the same asset", () => {
    const projectFile = projectFileToImageItem(45, {
      id: 1,
      path: "assets/hero.png",
      mimeType: "image/png",
      updatedAt: "2026-07-28T18:00:00.000Z",
    });
    const zeroEvent = parseZeroGeneratedImageEvent(45, {
      id: 14,
      taskId: 123,
      eventType: "generate_image",
      message: JSON.stringify({
        tool: "generate_image",
        path: "assets/hero.png",
        mimeType: "image/png",
        previewDataUri: "data:image/png;base64,AAAA",
      }),
      createdAt: "2026-07-28T18:01:00.000Z",
    });

    expect(
      mergeProjectImageItems(projectFile ? [projectFile] : [], zeroEvent ? [zeroEvent] : []),
    ).toEqual([
      expect.objectContaining({ source: "zero", imageUrl: "data:image/png;base64,AAAA" }),
    ]);
  });
});

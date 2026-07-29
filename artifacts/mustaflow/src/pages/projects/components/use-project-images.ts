import { authFetch } from "@/lib/api-fetch";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  mergeProjectImageItems,
  parseZeroGeneratedImageEvent,
  projectFileToImageItem,
  studioImageToItem,
  studioInsertPath,
  type ProjectImageFile,
  type ProjectImageItem,
  type ProjectImageTaskEvent,
  type StudioImageRecord,
} from "./project-image-model";

export interface GenerateProjectImageOptions {
  quality: "draft" | "standard" | "high";
  aspectRatio: "1:1" | "16:9" | "9:16";
  style: "vivid" | "natural";
  purpose?: string;
}

interface GenerateImageResponse {
  jobId: string;
  imageId: number;
  status: string;
}

export function selectRecentTaskIds(taskIds: number[], limit: number): number[] {
  return [...new Set(taskIds)].slice(0, Math.max(0, limit));
}

function blobToBase64(blob: Blob): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onerror = () => reject(reader.error ?? new Error("Could not read image"));
    reader.onload = () => {
      const result = typeof reader.result === "string" ? reader.result : "";
      const comma = result.indexOf(",");
      if (comma < 0) {
        reject(new Error("Image data was not base64 encoded"));
        return;
      }
      resolve(result.slice(comma + 1));
    };
    reader.readAsDataURL(blob);
  });
}

export function useProjectImages({
  projectId,
  enabled,
  taskIds,
  projectFiles,
  liveAssets,
  onThreadImage,
  onProjectFileInserted,
}: {
  projectId: number;
  enabled: boolean;
  taskIds: number[];
  projectFiles: ProjectImageFile[];
  liveAssets: ProjectImageItem[];
  onThreadImage: (image: ProjectImageItem) => void;
  onProjectFileInserted?: () => void;
}) {
  const [studioImages, setStudioImages] = useState<ProjectImageItem[]>([]);
  const [taskAssets, setTaskAssets] = useState<ProjectImageItem[]>([]);
  const [insertedAssets, setInsertedAssets] = useState<ProjectImageItem[]>([]);
  const [loading, setLoading] = useState(false);
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [historyTaskLimit, setHistoryTaskLimit] = useState(6);
  const sessionStudioIdsRef = useRef<Set<number>>(new Set());
  const onThreadImageRef = useRef(onThreadImage);
  const onProjectFileInsertedRef = useRef(onProjectFileInserted);

  useEffect(() => {
    onThreadImageRef.current = onThreadImage;
  }, [onThreadImage]);

  useEffect(() => {
    onProjectFileInsertedRef.current = onProjectFileInserted;
  }, [onProjectFileInserted]);

  const fetchStudioImages = useCallback(async () => {
    try {
      const response = await authFetch(
        `/api/images?projectId=${encodeURIComponent(String(projectId))}&limit=50`,
      );
      if (!response.ok) throw new Error("Could not load project images");
      const body = (await response.json()) as { images?: StudioImageRecord[] };
      const next = (body.images ?? []).map(studioImageToItem);
      setStudioImages(next);
      for (const image of next) {
        if (typeof image.id === "number" && sessionStudioIdsRef.current.has(image.id)) {
          onThreadImageRef.current(image);
        }
      }
      setError(null);
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : "Could not load project images");
    } finally {
      setLoading(false);
    }
  }, [projectId]);

  useEffect(() => {
    setStudioImages([]);
    setTaskAssets([]);
    setInsertedAssets([]);
    setHistoryTaskLimit(6);
    sessionStudioIdsRef.current.clear();
    if (!enabled) {
      setLoading(false);
      return;
    }
    setLoading(true);
    void fetchStudioImages();
  }, [enabled, fetchStudioImages]);

  const taskIdsKey = taskIds.join(",");
  useEffect(() => {
    if (!enabled) return;
    let cancelled = false;
    const uniqueTaskIds = selectRecentTaskIds(taskIds, historyTaskLimit);
    if (uniqueTaskIds.length === 0) {
      setTaskAssets([]);
      return;
    }

    void (async () => {
      const collected: ProjectImageItem[] = [];
      for (let offset = 0; offset < uniqueTaskIds.length; offset += 6) {
        const batch = uniqueTaskIds.slice(offset, offset + 6);
        const responses = await Promise.all(
          batch.map(async (taskId) => {
            try {
              const response = await authFetch(`/api/projects/${projectId}/tasks/${taskId}/events`);
              if (!response.ok) return [];
              return (await response.json()) as ProjectImageTaskEvent[];
            } catch {
              return [];
            }
          }),
        );
        if (cancelled) return;
        for (const events of responses) {
          for (const event of events) {
            const image = parseZeroGeneratedImageEvent(projectId, event);
            if (image) collected.push(image);
          }
        }
      }
      if (!cancelled) setTaskAssets(mergeProjectImageItems(collected));
    })();

    return () => {
      cancelled = true;
    };
    // taskIdsKey is the stable signal; taskIds is intentionally excluded.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [enabled, historyTaskLimit, projectId, taskIdsKey]);

  const hasPendingStudioImage = studioImages.some(
    (image) => image.status === "pending" || image.status === "generating",
  );
  useEffect(() => {
    if (!enabled || !hasPendingStudioImage) return;
    const interval = setInterval(() => void fetchStudioImages(), 2_000);
    return () => clearInterval(interval);
  }, [enabled, fetchStudioImages, hasPendingStudioImage]);

  const generateImage = useCallback(
    async (prompt: string, options: GenerateProjectImageOptions) => {
      const trimmedPrompt = prompt.trim();
      if (!trimmedPrompt || submitting) return;
      setSubmitting(true);
      setError(null);
      try {
        const response = await authFetch("/api/images/generate", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            prompt: trimmedPrompt,
            quality: options.quality,
            aspectRatio: options.aspectRatio,
            style: options.style,
            purpose: options.purpose ?? "general",
            transparentBackground: false,
            variationCount: 1,
            projectId,
          }),
        });
        const body = (await response.json().catch(() => ({}))) as GenerateImageResponse & {
          error?: string;
        };
        if (!response.ok || typeof body.imageId !== "number") {
          throw new Error(body.error ?? "Image generation could not start");
        }

        sessionStudioIdsRef.current.add(body.imageId);
        const pendingImage: ProjectImageItem = {
          key: `studio:${body.imageId}`,
          source: "studio",
          id: body.imageId,
          jobId: body.jobId,
          prompt: trimmedPrompt,
          status: body.status === "generating" ? "generating" : "pending",
          quality: options.quality,
          aspectRatio: options.aspectRatio,
          style: options.style,
          purpose: options.purpose ?? "general",
          createdAt: new Date().toISOString(),
        };
        setStudioImages((current) => mergeProjectImageItems([pendingImage], current));
        onThreadImageRef.current(pendingImage);
      } catch (caught) {
        const message = caught instanceof Error ? caught.message : "Image generation failed";
        setError(message);
        throw caught;
      } finally {
        setSubmitting(false);
      }
    },
    [projectId, submitting],
  );

  const regenerateImage = useCallback(
    async (image: ProjectImageItem) => {
      await generateImage(image.prompt, {
        quality: image.quality === "draft" || image.quality === "high" ? image.quality : "standard",
        aspectRatio:
          image.aspectRatio === "16:9" || image.aspectRatio === "9:16" ? image.aspectRatio : "1:1",
        style: image.style === "natural" ? "natural" : "vivid",
        purpose: image.purpose ?? "general",
      });
    },
    [generateImage],
  );

  const insertIntoProject = useCallback(
    async (image: ProjectImageItem): Promise<string> => {
      if (image.path) return image.path;
      if (typeof image.id !== "number" || image.status !== "completed") {
        throw new Error("This image is not ready to insert");
      }

      const path = studioInsertPath(image.id);
      const fileResponse = await authFetch(`/api/images/${image.id}/file`);
      if (!fileResponse.ok) throw new Error("Could not load the generated image");
      const content = await blobToBase64(await fileResponse.blob());
      const createResponse = await authFetch(`/api/projects/${projectId}/files`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ path, content }),
      });
      if (!createResponse.ok && createResponse.status !== 409) {
        const body = (await createResponse.json().catch(() => ({}))) as { error?: string };
        throw new Error(body.error ?? "Could not add the image to this project");
      }

      const inserted: ProjectImageItem = {
        ...image,
        key: `asset:${path}`,
        source: "project",
        path,
        imageUrl: `/api/projects/${projectId}/preview/${path}`,
        createdAt: new Date().toISOString(),
      };
      setInsertedAssets((current) => mergeProjectImageItems([inserted], current));
      onProjectFileInsertedRef.current?.();
      return path;
    },
    [projectId],
  );

  const projectFileImages = useMemo(
    () =>
      projectFiles
        .map((file) => projectFileToImageItem(projectId, file))
        .filter((image): image is ProjectImageItem => image !== null),
    [projectFiles, projectId],
  );

  const images = useMemo(
    () =>
      mergeProjectImageItems(
        projectFileImages,
        taskAssets,
        insertedAssets,
        liveAssets,
        studioImages,
      ),
    [insertedAssets, liveAssets, projectFileImages, studioImages, taskAssets],
  );

  return {
    images,
    loading,
    error,
    isGenerating: submitting || hasPendingStudioImage,
    generateImage,
    regenerateImage,
    insertIntoProject,
    refresh: fetchStudioImages,
    hasMoreHistory: new Set(taskIds).size > historyTaskLimit,
    loadMoreHistory: () => setHistoryTaskLimit((current) => current + 6),
  };
}

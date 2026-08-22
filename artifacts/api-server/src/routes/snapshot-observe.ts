import { randomUUID } from "node:crypto";
import { Router, type IRouter, type Request, type RequestHandler, type Response } from "express";
import { and, asc, eq, sql } from "drizzle-orm";
import { z } from "zod";
import {
  agentTasksTable,
  chatMessagesTable,
  db,
  projectFilesTable,
  projectsTable,
} from "@workspace/db";
import type { AgentMode } from "../lib/ai";
import { takeScreenshot, type ScreenshotInput, type ScreenshotResult } from "../lib/agent-senses";
import { runConversePipeline } from "../lib/builder";
import type { ConversationTurn } from "../lib/builder";
import { requireProjectOwnership } from "../lib/auth";
import { deductCreditsAtomic } from "../lib/credits";
import { shouldRouteToLivePreview } from "../lib/livePreviewProxy";
import { governIntentAdmission } from "../lib/zero-intent-admission";
import { intentReceiptStore } from "../lib/zero-intent-receipt-store";
import { logger } from "../lib/logger";

export const MAX_SNAPSHOT_BYTES = 4 * 1024 * 1024;
const SNAPSHOT_UNAVAILABLE_MESSAGE =
  "I couldn't capture this preview safely. Please make sure the server preview is available and try again.";
const SNAPSHOT_OBSERVE_PROMPT =
  "Observe the captured preview. Describe what is visible, identify any clear problems, and suggest the most useful next step without changing the project.";

const SnapshotBody = z
  .object({
    path: z
      .string()
      .max(512)
      .refine((value) => value.startsWith("/") && !value.startsWith("//"), {
        message: "path must be a relative preview route",
      })
      .refine((value) => {
        try {
          return new URL(value, "https://preview.invalid").origin === "https://preview.invalid";
        } catch {
          return false;
        }
      }, "path must not include a scheme or host"),
    previewSource: z.enum(["server", "webcontainer"]),
    viewport: z
      .object({
        width: z.number().int().min(320).max(1920),
        height: z.number().int().min(240).max(1200),
      })
      .strict(),
  })
  .strict();

export type SnapshotPreviewClass = "db-static" | "runtime-proxy" | "cloudflare-grant";
export type SnapshotObserveBody = z.infer<typeof SnapshotBody>;

export type SnapshotProject = {
  id: number;
  name: string;
  ownerId: string;
  status: string;
  agentMode: string;
  builderMode: string;
  containerId: string | null;
  containerStatus: string;
};

export type SnapshotCompletionInput = {
  project: SnapshotProject;
  previewClass: SnapshotPreviewClass;
  dataUri: string;
  actorUserId: string;
};

export type SnapshotObserveDependencies = {
  loadProject(projectId: number): Promise<SnapshotProject | null>;
  capture(input: ScreenshotInput): Promise<ScreenshotResult>;
  complete(input: SnapshotCompletionInput): Promise<Record<string, unknown>>;
};

export function snapshotPreviewClass(
  project: Pick<SnapshotProject, "builderMode" | "containerId" | "containerStatus">,
  tenantRuntimeProvider = process.env.TENANT_RUNTIME_PROVIDER,
): SnapshotPreviewClass {
  if (!shouldRouteToLivePreview(project)) return "db-static";
  if (
    tenantRuntimeProvider?.trim() === "cloudflare" &&
    project.containerId &&
    project.containerStatus === "running"
  ) {
    return "cloudflare-grant";
  }
  return "runtime-proxy";
}

export function nabuflowSessionCookies(
  header: string | undefined,
): Array<{ name: string; value: string }> {
  if (!header) return [];
  const cookies: Array<{ name: string; value: string }> = [];
  for (const part of header.split(";")) {
    const separator = part.indexOf("=");
    if (separator <= 0) continue;
    const name = part.slice(0, separator).trim();
    const value = part.slice(separator + 1).trim();
    if (!/^__session(?:_[A-Za-z0-9_-]+)?$/u.test(name) || value.length === 0) continue;
    cookies.push({ name, value });
  }
  return cookies;
}

function snapshotUnavailable(res: Response): void {
  res.status(503).json({ code: "snapshot_unavailable", error: SNAPSHOT_UNAVAILABLE_MESSAGE });
}

function requestOrigin(req: Request): string | null {
  const host = req.get("host");
  if (!host) return null;
  const forwardedProtocol = req.get("x-forwarded-proto")?.split(",")[0]?.trim();
  const protocol =
    forwardedProtocol === "https" || forwardedProtocol === "http"
      ? forwardedProtocol
      : req.protocol;
  try {
    const origin = new URL(`${protocol}://${host}`).origin;
    if (process.env.NODE_ENV !== "production") return origin;
    const allowedHosts = new Set(
      (process.env.REPLIT_DOMAINS ?? "")
        .split(",")
        .map((entry) => entry.trim().toLowerCase())
        .filter(Boolean),
    );
    for (const candidate of [
      process.env.MUSTAFLOW_WEB_URL,
      process.env.WEB_BASE_URL,
      process.env.PLATFORM_DOMAIN,
    ]) {
      if (!candidate?.trim()) continue;
      try {
        allowedHosts.add(
          candidate.includes("://")
            ? new URL(candidate).host.toLowerCase()
            : candidate.toLowerCase(),
        );
      } catch {
        // Invalid configuration cannot authorize a capture host.
      }
    }
    return allowedHosts.has(new URL(origin).host.toLowerCase()) ? origin : null;
  } catch {
    return null;
  }
}

function isPng(buffer: Buffer): boolean {
  return (
    buffer.length >= 8 &&
    buffer.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]))
  );
}

export function createSnapshotObserveRouter(
  dependencies: SnapshotObserveDependencies,
  ownership: RequestHandler = requireProjectOwnership,
): IRouter {
  const router: IRouter = Router();

  router.post("/projects/:id/observe/snapshot", ownership, async (req, res): Promise<void> => {
    const projectId = Number(req.params.id);
    if (!Number.isSafeInteger(projectId) || projectId < 1) {
      res.status(400).json({ error: "Invalid project id" });
      return;
    }
    const parsed = SnapshotBody.safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json({ error: "The snapshot request is invalid." });
      return;
    }
    if (parsed.data.previewSource === "webcontainer") {
      snapshotUnavailable(res);
      return;
    }

    const project = await dependencies.loadProject(projectId);
    const actorUserId = req.userId;
    const origin = requestOrigin(req);
    const cookies = nabuflowSessionCookies(req.headers.cookie);
    if (!project || !actorUserId || !origin || cookies.length === 0) {
      snapshotUnavailable(res);
      return;
    }

    const captureUrl = new URL(
      `/api/projects/${projectId}/preview${parsed.data.path}`,
      origin,
    ).toString();
    let capture: ScreenshotResult | undefined;
    try {
      capture = await dependencies.capture({
        url: captureUrl,
        width: parsed.data.viewport.width,
        height: parsed.data.viewport.height,
        fullPage: false,
        signal: AbortSignal.timeout(25_000),
        exactOriginCookies: cookies,
        exactCookieOrigin: origin,
      });
      const base64 = capture.base64;
      let finalOrigin: string | null = null;
      try {
        finalOrigin = capture.finalUrl ? new URL(capture.finalUrl).origin : null;
      } catch {
        finalOrigin = null;
      }
      if (!capture.ok || !base64 || (finalOrigin !== null && finalOrigin !== origin)) {
        snapshotUnavailable(res);
        return;
      }
      const png = Buffer.from(base64, "base64");
      if (png.length === 0 || png.length > MAX_SNAPSHOT_BYTES || !isPng(png)) {
        snapshotUnavailable(res);
        return;
      }
      const dataUri = `data:image/png;base64,${base64}`;
      const result = await dependencies.complete({
        project,
        previewClass: snapshotPreviewClass(project),
        dataUri,
        actorUserId,
      });
      res.status(200).json(result);
    } catch (error) {
      logger.warn(
        { projectId, errorType: error instanceof Error ? error.name : "UnknownError" },
        "snapshot observation unavailable",
      );
      snapshotUnavailable(res);
    } finally {
      if (capture) delete capture.base64;
    }
  });

  return router;
}

async function loadSnapshotProject(projectId: number): Promise<SnapshotProject | null> {
  const [project] = await db
    .select({
      id: projectsTable.id,
      name: projectsTable.name,
      ownerId: projectsTable.ownerId,
      status: projectsTable.status,
      agentMode: projectsTable.agentMode,
      builderMode: projectsTable.builderMode,
      containerId: projectsTable.containerId,
      containerStatus: projectsTable.containerStatus,
    })
    .from(projectsTable)
    .where(eq(projectsTable.id, projectId));
  return project ?? null;
}

async function completeSnapshotObservation(
  input: SnapshotCompletionInput,
): Promise<Record<string, unknown>> {
  const deduction = await deductCreditsAtomic(input.actorUserId, 1, {
    type: "converse",
    description: `Project observation — project ${input.project.id}`,
    projectId: input.project.id,
  });
  if ("insufficient" in deduction) throw new Error("snapshot observation credit unavailable");

  const [currentFiles, recentMessages] = await Promise.all([
    db
      .select({
        path: projectFilesTable.path,
        content: projectFilesTable.content,
        mimeType: projectFilesTable.mimeType,
      })
      .from(projectFilesTable)
      .where(eq(projectFilesTable.projectId, input.project.id)),
    db
      .select({ role: chatMessagesTable.role, content: chatMessagesTable.content })
      .from(chatMessagesTable)
      .where(eq(chatMessagesTable.projectId, input.project.id))
      .orderBy(asc(chatMessagesTable.createdAt)),
  ]);
  const conversationHistory: ConversationTurn[] = recentMessages
    .filter((message) => message.role === "user" || message.role === "assistant")
    .map((message) => ({
      role: message.role as "user" | "assistant",
      content: message.content,
    }))
    .slice(-8);
  const requestId = randomUUID();
  const receipt = await intentReceiptStore.persist(input.project.id, requestId, {
    intent: "observe",
    decidingSource: "snapshot_control",
    confidence: null,
    reasonCode: "snapshot_request",
  });
  const [userMessage] = await db
    .insert(chatMessagesTable)
    .values({
      projectId: input.project.id,
      role: "user",
      content: SNAPSHOT_OBSERVE_PROMPT,
      agentMode: input.project.agentMode,
      planMode: false,
      origin: "snapshot_control",
      intentReceiptId: receipt.receiptId,
    })
    .returning();
  if (!userMessage) throw new Error("snapshot observation message unavailable");
  await intentReceiptStore.linkMessage(receipt.receiptId, userMessage.id);

  const [task] = await db
    .insert(agentTasksTable)
    .values({
      projectId: input.project.id,
      title: `Observe ${input.previewClass} preview`,
      kind: "converse",
      status: "answering",
      prompt: SNAPSHOT_OBSERVE_PROMPT,
      agentIdentity: "main",
      origin: "snapshot_control",
    })
    .returning();
  if (!task) throw new Error("snapshot observation task unavailable");
  await governIntentAdmission({
    phase: "creator",
    projectId: input.project.id,
    taskId: task.id,
    requestId,
    mutationCapable: false,
    receipt,
  });

  let converse: Awaited<ReturnType<typeof runConversePipeline>>;
  try {
    converse = await runConversePipeline({
      projectName: input.project.name,
      userPrompt: SNAPSHOT_OBSERVE_PROMPT,
      conversationHistory,
      currentFiles,
      agentMode: input.project.agentMode as AgentMode,
      imageAttachments: [{ dataUri: input.dataUri, alt: `${input.previewClass} preview` }],
    });
  } catch {
    const failure = "I captured the preview, but couldn't finish observing it. Please try again.";
    await db
      .update(agentTasksTable)
      .set({ status: "failed", result: failure, failureReason: failure, completedAt: sql`now()` })
      .where(and(eq(agentTasksTable.id, task.id), eq(agentTasksTable.projectId, input.project.id)));
    await db.insert(chatMessagesTable).values({
      projectId: input.project.id,
      role: "assistant",
      content: failure,
      agentMode: input.project.agentMode,
      planMode: false,
      plan: { kind: "error", message: failure, intent: "observe" },
      origin: "snapshot_control",
    });
    throw new Error("snapshot observation model unavailable");
  }
  const assistantContent = `I captured the ${input.previewClass} preview.\n\n${converse.markdown}`;
  await db
    .update(agentTasksTable)
    .set({ status: "completed", result: assistantContent, completedAt: sql`now()` })
    .where(and(eq(agentTasksTable.id, task.id), eq(agentTasksTable.projectId, input.project.id)));
  const [assistantMessage] = await db
    .insert(chatMessagesTable)
    .values({
      projectId: input.project.id,
      role: "assistant",
      content: assistantContent,
      agentMode: input.project.agentMode,
      planMode: false,
      plan: {
        kind: "converse",
        taskId: task.id,
        intent: "observe",
        previewClass: input.previewClass,
      },
      origin: "snapshot_control",
    })
    .returning();
  if (!assistantMessage) throw new Error("snapshot observation response unavailable");

  return {
    ok: true,
    previewClass: input.previewClass,
    receiptId: receipt.receiptId,
    userMessageId: userMessage.id,
    assistantMessageId: assistantMessage.id,
    taskId: task.id,
  };
}

const router = createSnapshotObserveRouter({
  loadProject: loadSnapshotProject,
  capture: takeScreenshot,
  complete: completeSnapshotObservation,
});

export default router;

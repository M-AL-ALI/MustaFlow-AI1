import { createHash, randomUUID } from "node:crypto";
import { Router, type IRouter, type Request, type RequestHandler, type Response } from "express";
import { asc, desc, eq } from "drizzle-orm";
import { z } from "zod";
import {
  agentTasksTable,
  assetAnalysisEventsTable,
  assetUsageTable,
  chatMessagesTable,
  db,
  projectFilesTable,
  projectVersionsTable,
  projectsTable,
} from "@workspace/db";
import type { AgentMode } from "../lib/ai";
import { takeScreenshot, type ScreenshotInput, type ScreenshotResult } from "../lib/agent-senses";
import { runConversePipeline } from "../lib/builder";
import type { ConversationTurn } from "../lib/builder";
import { requireProjectOwnership } from "../lib/auth";
import {
  resolveCloudflareLivePreviewLaunchUrl,
  shouldRouteToLivePreview,
} from "../lib/livePreviewProxy";
import { governIntentAdmission } from "../lib/zero-intent-admission";
import { intentReceiptStore } from "../lib/zero-intent-receipt-store";
import { logger } from "../lib/logger";
import {
  failedTerminal,
  presentZeroTerminalV1,
  responseSucceededTerminal,
} from "@workspace/ora-contracts";
import { persistZeroTerminal, zeroTerminalRef } from "../lib/zero-terminal-persistence";
import {
  beginAssetUpload,
  completeAsset,
  rejectReservedAsset,
  reserveAsset,
} from "../lib/asset-registry";
import { deleteAssetObject, putAssetBuffer } from "../lib/asset-r2";
import { nabuflowGateHttpError } from "../lib/nabuflow-billing";

export const MAX_SNAPSHOT_BYTES = 4 * 1024 * 1024;
const SNAPSHOT_UNAVAILABLE_MESSAGE =
  "I couldn't capture this preview safely. Please make sure the server preview is available and try again.";
const SNAPSHOT_OBSERVE_PROMPT =
  "Observe the captured preview. Describe what is visible, identify any clear problems, and suggest the most useful next step without changing the project.";

const CaptureRect = z
  .object({
    x: z.number().int().min(0).max(1919),
    y: z.number().int().min(0).max(1199),
    width: z.number().int().min(16).max(1920),
    height: z.number().int().min(16).max(1200),
  })
  .strict();

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
    region: CaptureRect.optional(),
    domPath: z.string().max(512).optional(),
    annotation: z.string().trim().max(200).optional(),
    redactions: z.array(CaptureRect).max(12).optional(),
  })
  .strict()
  .superRefine((value, context) => {
    const rects = [...(value.region ? [value.region] : []), ...(value.redactions ?? [])];
    for (const rect of rects) {
      if (
        rect.x + rect.width > value.viewport.width ||
        rect.y + rect.height > value.viewport.height
      ) {
        context.addIssue({
          code: z.ZodIssueCode.custom,
          message: "capture rectangles must stay inside the viewport",
        });
        return;
      }
    }
  });

export type SnapshotPreviewClass = "db-static" | "runtime-proxy" | "cloudflare-grant";
export type SnapshotObserveBody = z.infer<typeof SnapshotBody>;

export type SnapshotFailureStage = "subject" | "capture" | "image" | "completion";
export type SnapshotFailureCause =
  | "preview-source-unavailable"
  | "project-unavailable"
  | "actor-unavailable"
  | "origin-unavailable"
  | "session-cookie-unavailable"
  | "preview-grant-unavailable"
  | "capture-unavailable"
  | "capture-origin-mismatch"
  | "capture-bytes-invalid"
  | "capture-errored"
  | "completion-errored";

export type SnapshotProject = {
  id: number;
  name: string;
  ownerId: string;
  status: string;
  agentMode: string;
  builderMode: string;
  containerId: string | null;
  containerStatus: string;
  runtimePort: number | null;
  stack: string | null;
  versionId?: number | null;
};

export type SnapshotCompletionInput = {
  project: SnapshotProject;
  previewClass: SnapshotPreviewClass;
  dataUri: string;
  actorUserId: string;
  path: string;
  viewport: { width: number; height: number; deviceMode: string };
  region?: { x: number; y: number; width: number; height: number };
  domPath?: string;
  annotation?: string;
  consoleErrors: string[];
};

export type SnapshotObserveDependencies = {
  loadProject(projectId: number): Promise<SnapshotProject | null>;
  authorizeVision?(
    project: SnapshotProject,
  ): Promise<{ status: number; body: Record<string, unknown> } | null>;
  resolveCloudflarePreview(project: SnapshotProject, requestPath: string): Promise<string | null>;
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

function snapshotUnavailable(
  res: Response,
  input: {
    projectId: number;
    stage: SnapshotFailureStage;
    cause: SnapshotFailureCause;
    errorType?: string;
  },
): void {
  logger.warn(
    {
      projectId: input.projectId,
      snapshotStage: input.stage,
      snapshotCause: input.cause,
      ...(input.errorType ? { errorType: input.errorType } : {}),
    },
    "snapshot observation unavailable",
  );
  res.status(503).json({
    code: "snapshot_unavailable",
    error: SNAPSHOT_UNAVAILABLE_MESSAGE,
    evidence: { stage: input.stage, cause: input.cause },
  });
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

function requestLoopbackOrigin(req: Request): string | null {
  const port = req.socket.localPort;
  if (!Number.isInteger(port) || !port || port < 1 || port > 65_535) return null;
  return `http://127.0.0.1:${port}`;
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
      snapshotUnavailable(res, {
        projectId,
        stage: "capture",
        cause: "preview-source-unavailable",
      });
      return;
    }

    const project = await dependencies.loadProject(projectId);
    const actorUserId = req.userId;
    const origin = requestOrigin(req);
    const loopbackOrigin = requestLoopbackOrigin(req);
    const cookies = nabuflowSessionCookies(req.headers.cookie);
    if (!project) {
      snapshotUnavailable(res, { projectId, stage: "subject", cause: "project-unavailable" });
      return;
    }
    if (!actorUserId) {
      snapshotUnavailable(res, { projectId, stage: "subject", cause: "actor-unavailable" });
      return;
    }
    if (!origin) {
      snapshotUnavailable(res, { projectId, stage: "capture", cause: "origin-unavailable" });
      return;
    }
    const billingBlock = await dependencies.authorizeVision?.(project);
    if (billingBlock) {
      res.status(billingBlock.status).json(billingBlock.body);
      return;
    }

    const previewClass = snapshotPreviewClass(project);
    let captureUrl: string;
    let approvedFinalOrigin: string;
    let captureCookies: Array<{ name: string; value: string }> | undefined;
    let captureCookieOrigin: string | undefined;
    let trustedLoopbackOrigin: string | undefined;
    if (previewClass === "cloudflare-grant") {
      let grantUrl: string | null;
      try {
        grantUrl = await dependencies.resolveCloudflarePreview(
          project,
          `/api/projects/${projectId}/preview${parsed.data.path}`,
        );
      } catch (error) {
        snapshotUnavailable(res, {
          projectId,
          stage: "capture",
          cause: "preview-grant-unavailable",
          errorType: error instanceof Error ? error.name : "UnknownError",
        });
        return;
      }
      if (!grantUrl) {
        snapshotUnavailable(res, {
          projectId,
          stage: "capture",
          cause: "preview-grant-unavailable",
        });
        return;
      }
      captureUrl = grantUrl;
      approvedFinalOrigin = new URL(grantUrl).origin;
    } else {
      if (!loopbackOrigin) {
        snapshotUnavailable(res, {
          projectId,
          stage: "capture",
          cause: "origin-unavailable",
        });
        return;
      }
      if (cookies.length === 0) {
        snapshotUnavailable(res, {
          projectId,
          stage: "capture",
          cause: "session-cookie-unavailable",
        });
        return;
      }
      captureUrl = new URL(
        `/api/projects/${projectId}/preview${parsed.data.path}`,
        loopbackOrigin,
      ).toString();
      approvedFinalOrigin = loopbackOrigin;
      captureCookies = cookies;
      captureCookieOrigin = loopbackOrigin;
      trustedLoopbackOrigin = loopbackOrigin;
    }
    let capture: ScreenshotResult | undefined;
    let activeStage: "capture" | "completion" = "capture";
    try {
      capture = await dependencies.capture({
        url: captureUrl,
        width: parsed.data.viewport.width,
        height: parsed.data.viewport.height,
        fullPage: false,
        signal: AbortSignal.timeout(25_000),
        exactOriginCookies: captureCookies,
        exactCookieOrigin: captureCookieOrigin,
        trustedLoopbackOrigin,
        clip: parsed.data.region,
        captureOverlay: {
          redactions: parsed.data.redactions,
          annotations: parsed.data.region
            ? [
                {
                  kind: "circle",
                  ...parsed.data.region,
                  text: parsed.data.annotation,
                },
              ]
            : undefined,
        },
      });
      const base64 = capture.base64;
      let finalOrigin: string | null = null;
      try {
        finalOrigin = capture.finalUrl ? new URL(capture.finalUrl).origin : null;
      } catch {
        finalOrigin = null;
      }
      if (!capture.ok || !base64) {
        snapshotUnavailable(res, {
          projectId,
          stage: "capture",
          cause: "capture-unavailable",
          errorType: capture.error ? "CaptureUnavailable" : undefined,
        });
        return;
      }
      if (finalOrigin !== null && finalOrigin !== approvedFinalOrigin) {
        snapshotUnavailable(res, {
          projectId,
          stage: "capture",
          cause: "capture-origin-mismatch",
        });
        return;
      }
      const png = Buffer.from(base64, "base64");
      if (png.length === 0 || png.length > MAX_SNAPSHOT_BYTES || !isPng(png)) {
        snapshotUnavailable(res, {
          projectId,
          stage: "image",
          cause: "capture-bytes-invalid",
        });
        return;
      }
      const dataUri = `data:image/png;base64,${base64}`;
      activeStage = "completion";
      const result = await dependencies.complete({
        project,
        previewClass,
        dataUri,
        actorUserId,
        path: parsed.data.path,
        viewport: {
          ...parsed.data.viewport,
          deviceMode:
            parsed.data.viewport.width <= 480
              ? "phone"
              : parsed.data.viewport.width <= 900
                ? "tablet"
                : "desktop",
        },
        region: parsed.data.region,
        domPath: parsed.data.domPath,
        annotation: parsed.data.annotation,
        consoleErrors: capture.consoleErrors ?? [],
      });
      res.status(200).json(result);
    } catch (error) {
      snapshotUnavailable(res, {
        projectId,
        stage: activeStage,
        cause: activeStage === "capture" ? "capture-errored" : "completion-errored",
        errorType: error instanceof Error ? error.name : "UnknownError",
      });
    } finally {
      if (capture) delete capture.base64;
    }
  });

  return router;
}

async function loadSnapshotProject(projectId: number): Promise<SnapshotProject | null> {
  const [[project], [version]] = await Promise.all([
    db
      .select({
        id: projectsTable.id,
        name: projectsTable.name,
        ownerId: projectsTable.ownerId,
        status: projectsTable.status,
        agentMode: projectsTable.agentMode,
        builderMode: projectsTable.builderMode,
        containerId: projectsTable.containerId,
        containerStatus: projectsTable.containerStatus,
        runtimePort: projectsTable.runtimePort,
        stack: projectsTable.stack,
      })
      .from(projectsTable)
      .where(eq(projectsTable.id, projectId)),
    db
      .select({ id: projectVersionsTable.id })
      .from(projectVersionsTable)
      .where(eq(projectVersionsTable.projectId, projectId))
      .orderBy(desc(projectVersionsTable.id))
      .limit(1),
  ]);
  return project ? { ...project, versionId: version?.id ?? null } : null;
}

async function completeSnapshotObservation(
  input: SnapshotCompletionInput,
): Promise<Record<string, unknown>> {
  const png = Buffer.from(input.dataUri.slice(input.dataUri.indexOf(",") + 1), "base64");
  const asset = await reserveAsset({
    productScope: "nabuflow",
    ownerUserId: input.project.ownerId,
    actorUserId: input.actorUserId,
    projectId: input.project.id,
    threadKey: `project:${input.project.id}`,
    scope: "project",
    kind: "snapshot",
    source: "observe",
    filename: `preview-${randomUUID()}.png`,
    mimeType: "image/png",
    sizeBytes: png.length,
    versionId: input.project.versionId,
    context: {
      route: input.path,
      viewport: input.viewport,
      region: input.region,
      domPath: input.domPath,
      annotation: input.annotation,
      consoleErrors: input.consoleErrors,
    },
  });
  try {
    const claim = await beginAssetUpload({ assetId: asset.id, actorUserId: input.actorUserId });
    if (!claim) throw new Error("snapshot_reservation_unavailable");
    await putAssetBuffer({ key: asset.storageKey, body: png, contentType: "image/png" });
    await completeAsset({
      assetId: asset.id,
      ownerUserId: input.project.ownerId,
      actorUserId: input.actorUserId,
      sha256: createHash("sha256").update(png).digest("hex"),
      scanState: "not-required",
    });
  } catch (error) {
    try {
      await deleteAssetObject(asset.storageKey);
    } catch {
      // The rejected registry row is the durable truth when provider cleanup is unavailable.
    }
    await rejectReservedAsset({
      assetId: asset.id,
      ownerUserId: input.project.ownerId,
      actorUserId: input.actorUserId,
      code: "asset_storage_unavailable",
    });
    throw error;
  }
  const persistedAttachment = {
    kind: "image",
    url: `/api/assets/${asset.id}/content`,
    alt: `${input.previewClass} ${input.region ? "preview region" : "preview"} at ${input.path}`,
    assetId: asset.id,
    versionId: input.project.versionId,
  };
  const [analysisEvent] = await db
    .insert(assetAnalysisEventsTable)
    .values({
      userId: input.actorUserId,
      projectId: input.project.id,
      assetId: asset.id,
      provider: "pending",
      model: "pending",
      customerCreditPrice: null,
      status: "started",
    })
    .returning({ id: assetAnalysisEventsTable.id });
  if (!analysisEvent) throw new Error("snapshot analysis receipt unavailable");

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
  const observationPrompt = [
    SNAPSHOT_OBSERVE_PROMPT,
    input.region ? `The user pointed to region ${JSON.stringify(input.region)}.` : null,
    input.domPath ? `DOM path under the selection: ${input.domPath}.` : null,
    input.annotation ? `Their annotation: ${input.annotation}` : null,
    input.consoleErrors.length
      ? `Sanitized console errors captured at the same moment:\n${input.consoleErrors.map((value) => `- ${value}`).join("\n")}`
      : "No console errors were captured at that moment.",
  ]
    .filter((value): value is string => Boolean(value))
    .join("\n\n");
  const requestId = randomUUID();
  const receipt = await intentReceiptStore.persist(input.project.id, requestId, {
    intent: "observe",
    decidingSource: "snapshot_control",
    confidence: null,
    reasonCode: "snapshot_request",
  });
  const userMessage = await db.transaction(async (tx) => {
    const [message] = await tx
      .insert(chatMessagesTable)
      .values({
        projectId: input.project.id,
        role: "user",
        content: observationPrompt,
        agentMode: input.project.agentMode,
        planMode: false,
        origin: "snapshot_control",
        intentReceiptId: receipt.receiptId,
        attachments: [persistedAttachment],
      })
      .returning();
    if (!message) throw new Error("snapshot observation message unavailable");
    await tx
      .insert(assetUsageTable)
      .values({
        assetId: asset.id,
        projectId: input.project.id,
        versionId: input.project.versionId,
        consumer: `chat-message:${message.id}`,
      })
      .onConflictDoNothing();
    return message;
  });
  if (!userMessage) throw new Error("snapshot observation message unavailable");
  await intentReceiptStore.linkMessage(receipt.receiptId, userMessage.id);

  const [task] = await db
    .insert(agentTasksTable)
    .values({
      projectId: input.project.id,
      title: `Observe ${input.previewClass} ${input.region ? "preview region" : "preview"}`,
      kind: "converse",
      status: "answering",
      prompt: observationPrompt,
      agentIdentity: "main",
      origin: "snapshot_control",
      intentReceiptId: receipt.receiptId,
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
      userPrompt: observationPrompt,
      conversationHistory,
      currentFiles,
      agentMode: input.project.agentMode as AgentMode,
      imageAttachments: [
        {
          dataUri: input.dataUri,
          alt: `${input.previewClass} ${input.region ? "preview region" : "preview"}`,
        },
      ],
    });
  } catch {
    await db
      .update(assetAnalysisEventsTable)
      .set({ status: "failed" })
      .where(eq(assetAnalysisEventsTable.id, analysisEvent.id));
    const failure = "I captured the preview, but couldn't finish observing it. Please try again.";
    const terminal = failedTerminal({
      schema: "zero-terminal-v1",
      taskId: task.id,
      intent: "observe",
      intentReceiptId: receipt.receiptId,
      completedAt: new Date().toISOString(),
      outcome: "failed",
      runStatus: "failed",
      cause: { code: "snapshot_observation_failed", stage: "observation" },
      evidence: { summary: failure },
    });
    const presentation = presentZeroTerminalV1(terminal);
    const [assistantMessage] = await db
      .insert(chatMessagesTable)
      .values({
        projectId: input.project.id,
        role: "assistant",
        content: presentation.message,
        agentMode: input.project.agentMode,
        planMode: false,
        plan: {
          kind: "error",
          message: presentation.message,
          intent: "observe",
          terminalRef: zeroTerminalRef(terminal),
        },
        origin: "snapshot_control",
      })
      .returning();
    if (!assistantMessage) throw new Error("snapshot observation failure response unavailable");
    const persisted = await persistZeroTerminal({
      terminal,
      allowedStatuses: ["answering"],
      taskUpdate: { failureReason: presentation.message },
    });
    if (!persisted) throw new Error("snapshot observation failure outcome unavailable");
    throw new Error("snapshot observation model unavailable");
  }
  await db
    .update(assetAnalysisEventsTable)
    .set({
      provider: converse.usage?.provider ?? "unreported",
      model: converse.usage?.model ?? "unreported",
      inputTokens: converse.usage?.inputTokens ?? 0,
      outputTokens: converse.usage?.outputTokens ?? 0,
      estimatedProviderCostMicros: Math.max(
        0,
        Math.round((converse.usage?.estimatedProviderCostUsd ?? 0) * 1_000_000),
      ),
      status: "completed",
    })
    .where(eq(assetAnalysisEventsTable.id, analysisEvent.id));
  const assistantContent = `I captured the ${input.previewClass} preview.\n\n${converse.markdown}`;
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
  const terminal = responseSucceededTerminal({
    schema: "zero-terminal-v1",
    taskId: task.id,
    intent: "observe",
    intentReceiptId: receipt.receiptId,
    completedAt: new Date().toISOString(),
    outcome: "response_succeeded",
    runStatus: "completed",
    evidence: {
      assistantMessageId: assistantMessage.id,
      stopEvidence: converse.stopEvidence,
    },
  });
  const persisted = await persistZeroTerminal({ terminal, allowedStatuses: ["answering"] });
  if (!persisted) throw new Error("snapshot observation outcome unavailable");
  await db
    .update(chatMessagesTable)
    .set({
      plan: {
        kind: "converse",
        taskId: task.id,
        intent: "observe",
        previewClass: input.previewClass,
        terminalRef: zeroTerminalRef(terminal),
      },
    })
    .where(eq(chatMessagesTable.id, assistantMessage.id));

  return {
    ok: true,
    previewClass: input.previewClass,
    receiptId: receipt.receiptId,
    userMessageId: userMessage.id,
    assistantMessageId: assistantMessage.id,
    taskId: task.id,
    terminalRef: zeroTerminalRef(terminal),
    asset: persistedAttachment,
    context: {
      route: input.path,
      viewport: input.viewport,
      region: input.region,
      domPath: input.domPath,
      consoleErrors: input.consoleErrors,
    },
  };
}

const router = createSnapshotObserveRouter({
  loadProject: loadSnapshotProject,
  authorizeVision: (project) =>
    nabuflowGateHttpError(project.ownerId, {
      engineMode: "eco",
      deepReasoning: false,
      projectedCredits: 1,
      source: "pipeline",
    }),
  resolveCloudflarePreview: resolveCloudflareLivePreviewLaunchUrl,
  capture: takeScreenshot,
  complete: completeSnapshotObservation,
});

export default router;

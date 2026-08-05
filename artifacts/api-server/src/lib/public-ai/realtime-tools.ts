import { eq } from "drizzle-orm";
import {
  oraActivityStep,
  type FileFormat,
  type OraRealtimeFunctionCall,
  type OraRealtimeToolBridgeResponse,
  type OraRealtimeToolName,
  type OraRealtimeToolResultCode,
  type OraRealtimeToolWrittenResult,
} from "@workspace/ora-contracts";
import { db, oraRepoSessionsTable, type OraRepoSessionRow } from "@workspace/db";
import { logger } from "../logger";
import {
  persistOraAsset,
  getNextVersionLineage,
  getNextVersionLineageFromAssetId,
} from "../ora-assets";
import { loadBrandKit } from "../brand-kit-loader";
import { generateImage, isImageProviderConfigured } from "../image-provider";
import { buildOraImageGenerationProfile } from "./image-quality";
import { isKillSwitchActive } from "./ora-kill-switches";
import { consumeOraQuota, refundOraQuota, type OraQuotaKind } from "./ora-usage";
import {
  buildCarriedDocumentContext,
  resolveCarriedFileMeta,
  type CarriedFileMeta,
} from "./carried-docs";
import { classifyEditIntent, isRevisionIntent } from "./edit-intent-classifier";
import { generateFileFromPrompt } from "./file-builder";
import { relinkDurableFileContextBestEffort } from "./file-context-store";
import { planOraMultiFile, resolveNamedEditTarget } from "./multi-file-planner";
import {
  REPO_GUIDANCE_ADDENDUM,
  resolveOraRepoSessionForRequest,
  runRepoInvestigation,
} from "./repo-analyst";
import { diffCommit, listFiles, readCommits, readFile, searchRepo } from "./repo-read-tools";
import { materializeRepoWorkspace, safeRepoWorkspaceFailure } from "./repo-workspace";
import { runOraWebSearch } from "./web-search";
import { classifyIntent, CLASSIFIER_FALLBACK } from "./classifier";
import {
  getOraProviderRoutingSnapshot,
  normalizeOraPlanTier,
  openAiModelForOraRoute,
  runCandidateChain,
  selectOraModelRoute,
  type ModelCandidate,
} from "./model-router";
import { createChatCompletion } from "../ai-providers";
import { REALTIME_TOOL_ACTIVITY } from "./realtime-tool-definitions";

export {
  ORA_REALTIME_TOOL_DEFINITIONS,
  assertRealtimeToolSurface,
  realtimeToolDefinitionsForClient,
  realtimeToolActivity,
  type RealtimeToolDefinition,
} from "./realtime-tool-definitions";

export interface OraRealtimeToolExecutionContext {
  userId: string | null;
  tier: string;
  oraSessionId: string;
  oraProjectId?: number | null;
  conversationId?: number | string | null;
  language?: string;
  history?: Array<{ role: "user" | "assistant"; content: string }>;
  documentRefs?: string[];
  activeArtifact?: { assetId: number; fileName: string; format: FileFormat } | null;
}

type ToolExecution =
  | {
      ok: true;
      output: string;
      writtenResult?: OraRealtimeToolWrittenResult;
    }
  | {
      ok: false;
      code: Exclude<OraRealtimeToolResultCode, "ok">;
      output: string;
      recoverable: true;
    };

export type OraRealtimeToolExecutor = (
  args: Record<string, unknown>,
  context: OraRealtimeToolExecutionContext,
) => Promise<ToolExecution>;

export type OraRealtimeToolExecutors = Record<OraRealtimeToolName, OraRealtimeToolExecutor>;

function toolSuccess(output: string, writtenResult?: OraRealtimeToolWrittenResult): ToolExecution {
  return { ok: true, output, ...(writtenResult ? { writtenResult } : {}) };
}

function toolFailure(
  code: Exclude<OraRealtimeToolResultCode, "ok">,
  output: string,
): ToolExecution {
  return { ok: false, code, output, recoverable: true };
}

function readString(args: Record<string, unknown>, key: string, max: number): string {
  return typeof args[key] === "string" ? args[key].trim().slice(0, max) : "";
}

function readPositiveInt(
  args: Record<string, unknown>,
  key: string,
  fallback: number,
  max: number,
): number {
  const value = typeof args[key] === "number" ? Math.floor(args[key]) : fallback;
  return Number.isFinite(value) ? Math.max(1, Math.min(value, max)) : fallback;
}

function parseArguments(argumentsJson: string): Record<string, unknown> {
  try {
    const parsed = JSON.parse(argumentsJson) as unknown;
    return parsed && typeof parsed === "object" && !Array.isArray(parsed)
      ? (parsed as Record<string, unknown>)
      : {};
  } catch {
    return {};
  }
}

function safeOutput(value: string, max = 40_000): string {
  const clean = value
    .replace(/[A-Za-z]:\\(?:[^\\\s]+\\)+/g, "")
    .replace(/\/(?:home|Users|var|tmp)\/[^\s]+/g, "")
    .trim();
  return clean.slice(0, max) || "The tool completed without a text result.";
}

function safeFailure(
  tool: OraRealtimeToolName,
  code: Exclude<OraRealtimeToolResultCode, "ok"> = "tool_failed",
): OraRealtimeToolBridgeResponse {
  const activityTool = REALTIME_TOOL_ACTIVITY[tool];
  return {
    ok: false,
    code,
    output:
      "This tool encountered an error and could not complete. Acknowledge the failure briefly and continue from what you know. Do not claim the tool returned a result.",
    activity: oraActivityStep(activityTool, "fail"),
    recoverable: true,
  };
}

type RepoAccessResult =
  | { status: "no_user" }
  | { status: "not_connected" }
  | { status: "github_unhealthy"; detail: string }
  | { status: "no_repo" }
  | { status: "ok"; token: string; session: OraRepoSessionRow };

async function resolveProjectId(context: OraRealtimeToolExecutionContext): Promise<number | null> {
  if (!context.userId || typeof context.oraProjectId !== "number") return null;
  const { checkOraProjectWritable } = await import("./ora-projects");
  const check = await checkOraProjectWritable(context.userId, context.oraProjectId);
  return check.ok ? context.oraProjectId : null;
}

async function repoAccess(
  args: Record<string, unknown>,
  context: OraRealtimeToolExecutionContext,
): Promise<RepoAccessResult> {
  if (!context.userId) return { status: "no_user" };
  const requestedRepo = readString(args, "repo", 250) || undefined;
  const message =
    readString(args, "question", 8000) || readString(args, "query", 4000) || requestedRepo || "";
  const resolved = await resolveOraRepoSessionForRequest({
    userId: context.userId,
    message,
    requestedRepo,
  });
  if (!resolved.connected) return { status: "not_connected" };
  if (resolved.failure && !resolved.session) {
    return { status: "github_unhealthy", detail: resolved.failure.detail };
  }
  if (!resolved.token || !resolved.session) return { status: "no_repo" };
  return { status: "ok", token: resolved.token, session: resolved.session };
}

async function executeRepoRead(
  name: "list_files" | "read_file" | "search_repo" | "read_commits" | "diff",
  args: Record<string, unknown>,
  context: OraRealtimeToolExecutionContext,
): Promise<ToolExecution> {
  const access = await repoAccess(args, context);
  if (access.status === "no_user") {
    return toolFailure("not_signed_in", "Repository access requires signing in first.");
  }
  if (access.status === "not_connected") {
    return toolFailure(
      "github_not_connected",
      "GitHub is not connected for this account. The user can connect it in Settings to enable repository tools.",
    );
  }
  if (access.status === "github_unhealthy") {
    return toolFailure(
      "github_not_connected",
      `${access.detail} Do not claim GitHub repository results were analyzed.`,
    );
  }
  if (access.status === "no_repo") {
    return toolFailure(
      "repo_not_resolved",
      "GitHub is connected, but no repository has been selected. Ask the user to name or select a repository; do not ask for a pasted URL.",
    );
  }

  const { token, session } = access;
  let result: { ok: boolean; content: string };
  if (name === "read_commits") {
    result = await readCommits(
      token,
      session.owner,
      session.repo,
      readPositiveInt(args, "limit", 10, 30),
    );
  } else if (name === "diff") {
    result = await diffCommit(token, session.owner, session.repo, readString(args, "sha", 100));
  } else {
    let workspace: Awaited<ReturnType<typeof materializeRepoWorkspace>>;
    try {
      workspace = await materializeRepoWorkspace({
        sessionId: session.id,
        owner: session.owner,
        repo: session.repo,
        ref: session.ref,
        defaultBranch: session.defaultBranch,
        branchSha: session.branchSha,
        treeSha: session.treeSha,
        token,
      });
    } catch (error) {
      return toolFailure(
        "repo_read_failed",
        `${safeRepoWorkspaceFailure(error)} Continue honestly without inventing findings.`,
      );
    }
    await db
      .update(oraRepoSessionsTable)
      .set({
        fileCount: workspace.files.length,
        totalBytes: workspace.totalBytes,
        lastUsedAt: new Date(),
      })
      .where(eq(oraRepoSessionsTable.id, session.id))
      .catch(() => {});
    if (name === "list_files") {
      result = listFiles(workspace, readString(args, "path", 500));
    } else if (name === "read_file") {
      result = await readFile(
        workspace,
        readString(args, "path", 500),
        readPositiveInt(args, "startLine", 1, 1_000_000),
        readPositiveInt(args, "endLine", 400, 1_000_000),
      );
    } else {
      result = await searchRepo(workspace, readString(args, "query", 200));
    }
  }
  return result.ok
    ? toolSuccess(result.content)
    : toolFailure(
        "repo_read_failed",
        `${result.content} Continue honestly without inventing results.`,
      );
}

async function repoCandidates(message: string, tier: string): Promise<ModelCandidate[]> {
  const classifier = await classifyIntent(message).catch(() => CLASSIFIER_FALLBACK);
  const planTier = normalizeOraPlanTier(tier);
  const routeTier = classifier.intent === "simple_faq" ? "fast" : "premium";
  const { available, openCircuits } = getOraProviderRoutingSnapshot();
  return selectOraModelRoute({
    tier: routeTier,
    subscriptionTier: planTier,
    topic: "technical",
    intent: classifier.intent,
    confidence: classifier.confidence,
    multilingual: false,
    available,
    openCircuits,
    openaiModel: openAiModelForOraRoute(routeTier, planTier),
  });
}

async function executeRepoAnalysis(
  args: Record<string, unknown>,
  context: OraRealtimeToolExecutionContext,
): Promise<ToolExecution> {
  if (!context.userId) {
    return toolFailure(
      "not_signed_in",
      "Repository analysis is available after the user signs in.",
    );
  }
  const question = readString(args, "question", 8000);
  if (!question) {
    return toolFailure("invalid_arguments", "Ask what the user wants checked in the repository.");
  }
  const candidates = await repoCandidates(question, context.tier);
  const investigation = await runRepoInvestigation({
    userId: context.userId,
    message: question,
    candidates,
    onStatus: () => {},
  });
  if (!investigation || investigation.stepsRun === 0) {
    return toolFailure(
      "no_code_analyzed",
      investigation?.contextBlock ??
        "No repository code was analyzed because the connected repository could not be resolved. Ask for its name or selection, not a URL.",
    );
  }

  const chain = await runCandidateChain(candidates, async (candidate) => {
    const completion = await createChatCompletion({
      provider: candidate.provider,
      model: candidate.model,
      messages: [
        {
          role: "system",
          content:
            "Write a concise but complete professional read-only repository report from the supplied evidence. Never claim to have changed code. Never reveal providers, model ids, stack traces, or absolute server paths.",
        },
        {
          role: "user",
          content: `${question}\n\n${investigation.contextBlock}${REPO_GUIDANCE_ADDENDUM}`,
        },
      ],
      response_format: { type: "text" },
      max_completion_tokens: 2200,
    });
    const report = completion.choices[0]?.message?.content?.trim() ?? "";
    if (!report) throw new Error("empty repository report");
    return report;
  });
  return toolSuccess(chain.result, { content: chain.result });
}

async function executeFileGeneration(
  args: Record<string, unknown>,
  context: OraRealtimeToolExecutionContext,
): Promise<ToolExecution> {
  const prompt = readString(args, "prompt", 8000);
  const format = readString(args, "format", 10) as FileFormat;
  if (!prompt || !["csv", "xlsx", "docx", "pdf", "pptx"].includes(format)) {
    return toolFailure(
      "invalid_arguments",
      "A complete file prompt and supported format are required.",
    );
  }

  const projectId = await resolveProjectId(context);
  const documentRefs = (context.documentRefs ?? []).slice(-5);
  let activeAssetBuffer: Buffer | null = null;
  let activeAssetFileName: string | null = null;
  let activeAssetContextText = "";
  const active = context.activeArtifact;

  if (active && context.userId && active.format === format) {
    try {
      const { getOraAssetBytes, getOraAssetMeta } = await import("../ora-assets");
      const [bytes, meta] = await Promise.all([
        getOraAssetBytes(active.assetId, context.userId),
        getOraAssetMeta(active.assetId, context.userId),
      ]);
      if (bytes && meta && isRevisionIntent(classifyEditIntent(prompt))) {
        activeAssetBuffer = bytes;
        activeAssetFileName = meta.fileName;
        if (format === "docx" || format === "pptx") {
          const { extractText } = await import("./file-extract");
          activeAssetContextText = (await extractText(bytes, format)).slice(0, 8000);
        }
      }
    } catch {
      activeAssetBuffer = null;
      activeAssetFileName = null;
    }
  }

  const carriedDocs = await buildCarriedDocumentContext(
    documentRefs,
    context.oraSessionId,
    prompt,
    context.userId,
  );
  const carriedFileMeta: CarriedFileMeta[] =
    documentRefs.length > 0
      ? await resolveCarriedFileMeta(documentRefs, context.oraSessionId, context.userId)
      : [];
  const multiFilePlan = planOraMultiFile({
    message: prompt,
    files: carriedFileMeta,
    finalTool: "file_generation",
  });
  const promptWithPlan = multiFilePlan ? `${prompt}\n\n${multiFilePlan.directive}` : prompt;
  let filePrompt = carriedDocs ? `${promptWithPlan}\n\n${carriedDocs}` : promptWithPlan;
  if (activeAssetFileName && activeAssetContextText) {
    filePrompt += `\n\n[ACTIVE WORKING FILE — REVISION TARGET]\nThe user wants to revise ${activeAssetFileName}. Apply only the requested changes and preserve everything else.\n"""\n${activeAssetContextText}\n"""\n[END ACTIVE WORKING FILE]`;
  }

  const { tryApplyLayoutPreservingFileEdit } = await import("./office-layout-edit");
  const layoutEdit = await tryApplyLayoutPreservingFileEdit({
    message: prompt,
    format,
    documentRefs,
    sessionId: context.oraSessionId,
    userId: context.userId,
    subscriptionTier: context.tier,
    preferredFileRef:
      multiFilePlan?.targetFileRef ?? resolveNamedEditTarget(prompt, carriedFileMeta),
    activeAssetBuffer,
    activeAssetFileName,
  });
  const brandKit = context.userId
    ? await loadBrandKit(context.userId, projectId).catch(() => null)
    : null;
  const hasSourceData = carriedDocs.length > 0 || activeAssetContextText.length > 0;
  const result =
    layoutEdit ??
    (await generateFileFromPrompt(
      filePrompt,
      format,
      context.history ?? [],
      context.language,
      hasSourceData,
      context.tier,
      brandKit,
    ));
  if (!layoutEdit && documentRefs.length > 0 && hasSourceData) {
    result.editQuality = {
      editMode: "redesigned",
      changes: [],
      outputFileName: result.fileName.slice(0, 300),
      preservedLayout: false,
      canRedesign: false,
    };
  }

  let assetId: number | null = null;
  if (context.userId) {
    const lineage =
      active && layoutEdit
        ? await getNextVersionLineageFromAssetId(context.userId, active.assetId)
        : result.editedFileRef
          ? await getNextVersionLineage(context.userId, result.editedFileRef)
          : null;
    const isRevision = Boolean((active && layoutEdit) || result.editedFileRef);
    assetId = await persistOraAsset({
      userId: context.userId,
      // Chained versions inherit their parent's project through lineage.
      // Only a standalone v1 uses the project resolved from this voice turn.
      oraProjectId: projectId,
      kind: "file",
      fileName: result.fileName,
      mimeType: result.mimeType,
      format,
      prompt,
      base64: result.fileData,
      ...(lineage ?? {}),
      sourceFileRef: result.editedFileRef ?? null,
      editSummary: isRevision
        ? (result.editQuality?.changes?.length
            ? result.editQuality.changes.join("; ")
            : `Revised: ${prompt}`
          ).slice(0, 300)
        : null,
    });
    if (assetId && result.editQuality) {
      result.editQuality.versionId = assetId;
    }
    if (assetId && result.editedFileRef) {
      relinkDurableFileContextBestEffort({
        fileRef: result.editedFileRef,
        sessionId: context.oraSessionId,
        userId: context.userId,
        assetId,
      });
    }
  }

  return toolSuccess(
    `The ${format.toUpperCase()} file is ready. Briefly explain what was created or changed and tell the user it is in the chat.`,
    {
      content: result.reply,
      ...(multiFilePlan ? { usedFiles: multiFilePlan.usedFiles } : {}),
      generatedFile: {
        fileName: result.fileName,
        fileData: result.fileData,
        mimeType: result.mimeType,
        format,
        ...(assetId ? { assetId } : {}),
        ...(result.editQuality ? { editQuality: result.editQuality } : {}),
      },
    },
  );
}

async function executeImageGeneration(
  args: Record<string, unknown>,
  context: OraRealtimeToolExecutionContext,
): Promise<ToolExecution> {
  if (!context.userId) {
    return toolFailure("not_signed_in", "Image generation is available after signing in.");
  }
  if (!isImageProviderConfigured()) {
    return toolFailure(
      "temporarily_unavailable",
      "Image generation is temporarily unavailable. Continue the conversation.",
    );
  }
  const prompt = readString(args, "prompt", 4000);
  if (!prompt) return toolFailure("invalid_arguments", "A complete image brief is required.");
  const profile = buildOraImageGenerationProfile({
    prompt,
    subscriptionTier: context.tier,
  });
  const result = await generateImage({
    prompt: profile.prompt,
    quality: profile.quality,
    aspectRatio: profile.aspectRatio,
    style: profile.style,
    subscriptionTier: context.tier,
  });

  let imageId: number | null = null;
  try {
    const parsed = result.openaiUrl.startsWith("data:")
      ? result.openaiUrl.match(/^data:([^;,]+);base64,(.+)$/s)
      : null;
    let mimeType = parsed?.[1] ?? "image/png";
    let base64 = parsed?.[2] ?? "";
    if (!base64) {
      const response = await fetch(result.openaiUrl);
      if (response.ok) {
        mimeType = response.headers.get("content-type") ?? mimeType;
        base64 = Buffer.from(await response.arrayBuffer()).toString("base64");
      }
    }
    if (base64) {
      const ext = mimeType.split("/")[1]?.split("+")[0] ?? "png";
      imageId = await persistOraAsset({
        userId: context.userId,
        oraProjectId: await resolveProjectId(context),
        kind: "image",
        fileName: `ora-image-${Date.now()}.${ext}`,
        mimeType,
        format: ext,
        prompt: profile.originalPrompt,
        base64,
      });
    }
  } catch (err) {
    logger.warn({ component: "ora-realtime-tool", err }, "Voice image persistence failed");
  }

  return toolSuccess(
    "The image is ready in the chat. Briefly describe it without reading any URL.",
    {
      content: "Here is the image you created with Ora.",
      imageUrl: result.openaiUrl,
      ...(imageId ? { imageId } : {}),
      imageMeta: {
        kind: profile.kind,
        aspectRatio: profile.aspectRatio,
        style: profile.style,
        quality: profile.quality,
      },
    },
  );
}

const DEFAULT_EXECUTORS: OraRealtimeToolExecutors = {
  web_search: async (args, context) => {
    if (!context.userId) {
      return toolFailure("not_signed_in", "Live web search is available after signing in.");
    }
    const query = readString(args, "query", 4000);
    if (!query) return toolFailure("invalid_arguments", "A complete search question is required.");
    const result = await runOraWebSearch({
      query,
      history: context.history,
      language: context.language,
      subscriptionTier: context.tier,
    });
    return toolSuccess(result.reply, { content: result.reply, sources: result.sources });
  },
  list_files: (args, context) => executeRepoRead("list_files", args, context),
  read_file: (args, context) => executeRepoRead("read_file", args, context),
  search_repo: (args, context) => executeRepoRead("search_repo", args, context),
  read_commits: (args, context) => executeRepoRead("read_commits", args, context),
  diff: (args, context) => executeRepoRead("diff", args, context),
  generate_file: executeFileGeneration,
  generate_image: executeImageGeneration,
  analyze_repo: executeRepoAnalysis,
};

function quotaKindForTool(name: OraRealtimeToolName): OraQuotaKind | null {
  if (name === "generate_file") return "message";
  if (name === "generate_image") return "image";
  return null;
}

async function refundReservedQuotaSafely(userId: string, quotaKind: OraQuotaKind): Promise<void> {
  try {
    await refundOraQuota(userId, quotaKind);
  } catch (err) {
    logger.warn(
      { component: "ora-realtime-tool", quotaKind, err },
      "Realtime tool quota refund failed",
    );
  }
}

/**
 * Execute one normalized realtime function call. Tool errors become a safe,
 * recoverable output for the model; they never terminate the live session.
 * Tests can inject executors without importing provider or database machinery.
 */
export async function executeOraRealtimeFunctionCall(
  call: OraRealtimeFunctionCall,
  context: OraRealtimeToolExecutionContext,
  executors: OraRealtimeToolExecutors = DEFAULT_EXECUTORS,
): Promise<OraRealtimeToolBridgeResponse> {
  const activityTool = REALTIME_TOOL_ACTIVITY[call.name];
  const args = parseArguments(call.argumentsJson);
  let quotaKind: OraQuotaKind | null = null;
  let quotaReserved = false;

  try {
    if (
      (call.name === "web_search" && isKillSwitchActive("web_search")) ||
      (call.name === "generate_file" && isKillSwitchActive("file_generation")) ||
      (call.name === "generate_image" && isKillSwitchActive("all"))
    ) {
      return safeFailure(call.name);
    }

    quotaKind = quotaKindForTool(call.name);
    if (quotaKind && context.userId) {
      const quota = await consumeOraQuota(context.userId, context.tier, quotaKind);
      if (!quota.allowed) {
        return {
          ok: false,
          code: "quota_reached",
          output: `That ${quotaKind === "image" ? "image" : "file"} limit is reached for now. Continue by voice without claiming the tool ran.`,
          activity: oraActivityStep(activityTool, "fail"),
          recoverable: true,
        };
      }
      quotaReserved = true;
    }

    const result = await executors[call.name](args, context);
    if (!result.ok) {
      if (quotaReserved && quotaKind && context.userId) {
        await refundReservedQuotaSafely(context.userId, quotaKind);
        quotaReserved = false;
      }
      return {
        ok: false,
        code: result.code,
        output: safeOutput(result.output),
        activity: oraActivityStep(activityTool, "fail"),
        recoverable: true,
      };
    }
    return {
      ok: true,
      code: "ok",
      output: safeOutput(result.output),
      activity: oraActivityStep(activityTool, "ok"),
      ...(result.writtenResult ? { writtenResult: result.writtenResult } : {}),
      recoverable: true,
    };
  } catch (err) {
    if (quotaReserved && quotaKind && context.userId) {
      await refundReservedQuotaSafely(context.userId, quotaKind);
    }
    logger.warn(
      { component: "ora-realtime-tool", tool: call.name, err },
      "Realtime tool execution failed safely",
    );
    return safeFailure(call.name);
  }
}

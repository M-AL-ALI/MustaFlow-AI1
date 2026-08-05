import { Router } from "express";
import { z } from "zod";
import {
  isSuccessfulOraGeneratedFilePayload,
  oraActivityStep,
  resolveOraFileFormatRequest,
} from "@workspace/ora-contracts";
import { logger } from "../../lib/logger";
import {
  validateSession,
  incrementMessageCount,
  setSessionCookie,
  MSG_LIMIT_VALUE,
} from "../../lib/public-ai/session";
import { isKillSwitchActive, killSwitchBody } from "../../lib/public-ai/ora-kill-switches";
import { scanUserInput } from "../../lib/public-ai/prompt";
import {
  buildCarriedDocumentContext,
  resolveCarriedFileMeta,
  type CarriedFileMeta,
} from "../../lib/public-ai/carried-docs";
import { buildFileAgentPreview } from "../../lib/public-ai/file-agent-preview";
import { planOraMultiFile, resolveNamedEditTarget } from "../../lib/public-ai/multi-file-planner";

const router = Router();

const messageItemSchema = z.object({
  role: z.enum(["user", "assistant"]),
  content: z.string(),
});

const bodySchema = z.object({
  message: z.string().min(1),
  messages: z.array(messageItemSchema).max(20).default([]),
  format: z.string().min(1).max(12),
  language: z.string().max(20).optional(),
  // IDs of files the user uploaded earlier this conversation. When present we
  // re-hydrate their real content so creation extracts/transforms actual data
  // instead of fabricating it.
  documentRefs: z.array(z.string().uuid()).max(5).default([]),
  // Ora project space the generated file should be filed under in the library.
  // Signed-in only; must name an active project owned by the caller. Null or
  // omitted = the user's Personal space.
  oraProjectId: z.number().int().positive().nullable().optional(),
  // Phase 10 — True Artifact Revision Engine: the asset id of the last file
  // this user generated/edited in this conversation. When provided, revision
  // requests are applied directly to these bytes (layout-preserving in-place
  // edit) instead of regenerating a lookalike from extracted text.
  // Signed-in only; anonymous users never have persisted assets.
  activeAssetId: z.number().int().positive().nullable().optional(),
});

router.post("/public-ai/generate-file", async (req, res) => {
  const parsed = bodySchema.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: "Invalid request body" });
    return;
  }

  const {
    message,
    messages,
    format: submittedFormat,
    language,
    documentRefs,
    oraProjectId,
    activeAssetId,
  } = parsed.data;

  if (isKillSwitchActive("file_generation")) {
    res.status(503).json(killSwitchBody("file_generation"));
    return;
  }

  const sessionToken = req.cookies?.["ora-session"] as string | undefined;
  if (!sessionToken) {
    res.status(401).json({ error: "No active session. Please start a session first." });
    return;
  }

  const session = validateSession(sessionToken);
  if (!session) {
    res.status(401).json({ error: "Session expired. Please start a new session." });
    return;
  }

  // Resolve the signed-in Ora user up-front. The anonymous per-session cap is a
  // side-effect-free read, so it can be signaled early; only the authed rolling-window
  // quota is RESERVED (consumed), and that reservation is deferred until after
  // cheap validation so rejected requests never consume a user's allowance.
  const [{ resolveAuthedOraUser }, { consumeOraQuota, refundOraQuota, oraMessageFields }] =
    await Promise.all([
      import("../../lib/public-ai/authed-user"),
      import("../../lib/public-ai/ora-usage"),
    ]);
  const authed = await resolveAuthedOraUser(req);
  if (!authed && session.msgCount >= MSG_LIMIT_VALUE) {
    res.status(429).json({
      error: "You have reached the message limit for this session.",
      msgCount: session.msgCount,
      msgLimit: MSG_LIMIT_VALUE,
    });
    return;
  }

  // ── Daily spend cap (global + per-IP anonymous) ─────────────────────────
  {
    const { checkOraSpendCapAsync } = await import("../../lib/public-ai/ora-spend-cap");
    const capResult = await checkOraSpendCapAsync(
      req,
      "file_generation",
      authed?.userId ?? null,
      authed?.tier ?? "anonymous",
    );
    if (!capResult.allowed) {
      res.status(429).json({
        error: capResult.message,
        limitType: capResult.limitType,
        upgradeAvailable: capResult.upgradeAvailable,
        resetAt: capResult.resetAt,
        retryAfter: capResult.retryAfter,
      });
      return;
    }
  }

  if (!scanUserInput(message)) {
    res.status(400).json({ error: "Message contains patterns that cannot be processed." });
    return;
  }

  const formatResolution = resolveOraFileFormatRequest(message, submittedFormat);
  if (!formatResolution.ok) {
    res.status(415).json(formatResolution);
    return;
  }
  const { format } = formatResolution;

  // Validate the requested Ora project space BEFORE consuming quota so a stale
  // or foreign project selection is rejected without charging the user. Only
  // meaningful for signed-in users; anonymous sessions have no projects.
  let libraryProjectId: number | null = null;
  if (authed && typeof oraProjectId === "number") {
    const { checkOraProjectWritable } = await import("../../lib/public-ai/ora-projects");
    const check = await checkOraProjectWritable(authed.userId, oraProjectId);
    if (!check.ok) {
      res.status(check.status).json({ error: check.error });
      return;
    }
    libraryProjectId = oraProjectId;
  }

  // File generation draws on the rolling-window MESSAGE bucket. consumeOraQuota is atomic;
  // the reservation is held below and only released via refundOraQuota on failure.
  if (authed) {
    const quota = await consumeOraQuota(authed.userId, authed.tier, "message");
    if (!quota.allowed) {
      res.status(429).json({
        error: `You've used all ${quota.limit} Ora messages in your current window on your plan. Upgrade for a higher limit, or wait for your window to reset.`,
        upgradeCta: true,
        msgCount: quota.used,
        msgLimit: quota.limit,
        resetsAt: quota.resetsAt,
      });
      return;
    }
  }

  const history = messages.slice(-10).map((m) => ({ role: m.role, content: m.content }));

  // Phase 10: resolve the active working artifact (last generated/edited file)
  // so revision requests can be applied directly to those bytes rather than
  // regenerating a lookalike. Only available for signed-in users who have a
  // persisted asset. Ownership is enforced by getOraAssetBytes.
  let activeAssetBuffer: Buffer | null = null;
  let activeAssetFileName: string | null = null;
  let activeAssetContextText = "";
  if (activeAssetId && authed) {
    try {
      const { getOraAssetBytes, getOraAssetMeta } = await import("../../lib/ora-assets");
      const [buffer, meta] = await Promise.all([
        getOraAssetBytes(activeAssetId, authed.userId),
        getOraAssetMeta(activeAssetId, authed.userId),
      ]);
      if (buffer && meta) {
        activeAssetBuffer = buffer;
        activeAssetFileName = meta.fileName;
        // xlsx not supported by extractText (txt/docx/pptx/pdf only).
        if (format === "docx" || format === "pptx") {
          try {
            const { extractText } = await import("../../lib/public-ai/file-extract");
            const text = await extractText(buffer, format as "docx" | "pptx");
            if (text.trim()) activeAssetContextText = text.slice(0, 8_000);
          } catch {
            // no text extraction — AI edit path still works
          }
        }
      }
    } catch (err) {
      logger.warn(
        { component: "ora-generate-file", activeAssetId, err },
        "Failed to resolve active asset; proceeding without revision target",
      );
    }
  }

  // Phase 10: classifier guard — skip the active revision buffer for
  // new-creation or full-redesign intents so "create a new deck about AI"
  // doesn't accidentally revise the tracked artifact.
  if (activeAssetBuffer && activeAssetFileName) {
    const { classifyEditIntent, isRevisionIntent } =
      await import("../../lib/public-ai/edit-intent-classifier");
    if (!isRevisionIntent(classifyEditIntent(message))) {
      activeAssetBuffer = null;
      activeAssetFileName = null;
      activeAssetContextText = "";
    }
  }

  // Re-hydrate any uploaded documents/datasets so the file is built from the
  // user's real data. Empty when nothing resolves (expired/foreign refs); in
  // that case generation falls back to its non-source-data behavior.
  const carriedDocs = await buildCarriedDocumentContext(
    documentRefs,
    session.sessionId,
    message,
    authed?.userId ?? null,
  );
  // Phase 5: cross-file workflow planning (2+ uploads only). This route is
  // explicitly file generation, so the planner never overrides the tool here;
  // it contributes the role directive, target steering, and usedFiles payload.
  const carriedFileMeta: CarriedFileMeta[] =
    documentRefs.length >= 2
      ? await resolveCarriedFileMeta(documentRefs, session.sessionId, authed?.userId ?? null)
      : [];
  const multiFilePlan = planOraMultiFile({
    message,
    files: carriedFileMeta,
    finalTool: "file_generation",
  });
  const promptWithPlan = multiFilePlan ? `${message}\n\n${multiFilePlan.directive}` : message;
  let filePrompt = carriedDocs ? `${promptWithPlan}\n\n${carriedDocs}` : promptWithPlan;
  // Inject extracted text from the active working artifact so the AI generates
  // something coherent when the layout edit path can't apply the change.
  if (activeAssetFileName && activeAssetContextText) {
    filePrompt =
      filePrompt +
      "\n\n[ACTIVE WORKING FILE — REVISION TARGET]\n" +
      `The user wants to revise this file: ${activeAssetFileName}\n` +
      "Apply only the requested changes. Preserve all other content, structure, and layout.\n\n" +
      `"""\n${activeAssetContextText}\n"""\n` +
      "[END OF ACTIVE WORKING FILE]";
  }
  const hasSourceData = carriedDocs.length > 0 || activeAssetContextText.length > 0;

  // Load brand kit for authenticated users (best-effort; never blocks file generation).
  let oraBrandKit: import("../../lib/public-ai/brand-kit-apply").BrandKit | null = null;
  if (authed) {
    try {
      const { loadBrandKit } = await import("../../lib/brand-kit-loader");
      oraBrandKit = await loadBrandKit(authed.userId, libraryProjectId);
    } catch {
      // Non-critical — file will be generated without branding.
    }
  }

  let FileGenerationErrorCtor:
    | (typeof import("../../lib/public-ai/file-builder"))["FileGenerationError"]
    | null = null;
  try {
    const fileBuilder = await import("../../lib/public-ai/file-builder");
    const { tryApplyLayoutPreservingFileEdit } =
      await import("../../lib/public-ai/office-layout-edit");
    FileGenerationErrorCtor = fileBuilder.FileGenerationError;
    const layoutEditResult = await tryApplyLayoutPreservingFileEdit({
      message,
      format,
      documentRefs,
      sessionId: session.sessionId,
      userId: authed?.userId ?? null,
      subscriptionTier: authed?.tier ?? null,
      // Plan target first; otherwise pin a file the user named by filename so
      // the ordered-refs scan never edits the wrong same-format upload.
      preferredFileRef:
        multiFilePlan?.targetFileRef ?? resolveNamedEditTarget(message, carriedFileMeta),
      // Phase 10: pass active working artifact bytes so revision requests are
      // applied in-place instead of regenerating a lookalike from text.
      activeAssetBuffer,
      activeAssetFileName,
    });
    const result =
      layoutEditResult ??
      (await fileBuilder.generateFileFromPrompt(
        filePrompt,
        format,
        history,
        language,
        hasSourceData,
        authed?.tier ?? null,
        oraBrandKit,
      ));
    if (
      !isSuccessfulOraGeneratedFilePayload(result, {
        format,
        requestedFileName: formatResolution.requestedFileName,
      })
    ) {
      throw new fileBuilder.FileGenerationError(
        "I couldn't generate the requested file. No download was created.",
      );
    }
    // The full generator rebuilt the file from an uploaded source's extracted
    // text — an honest "redesigned" stamp so the quality card can say the
    // original layout was NOT carried over. Pure from-scratch generation
    // (no uploaded source) intentionally gets no editQuality at all.
    if (!layoutEditResult && documentRefs.length > 0 && hasSourceData) {
      result.editQuality = {
        editMode: "redesigned",
        changes: [],
        outputFileName: result.fileName.slice(0, 300),
        preservedLayout: false,
        canRedesign: false,
      };
    }

    // Persist to the durable asset library for signed-in users so the file
    // survives chat resets, reloads, and other devices. Best-effort — a library
    // failure must never break generation. The returned asset id is surfaced on
    // the response so the download card stays usable after reload.
    let assetId: number | null = null;
    if (authed) {
      try {
        const { persistOraAsset, getNextVersionLineage, getNextVersionLineageFromAssetId } =
          await import("../../lib/ora-assets");
        // Version lineage: Phase 10 active-asset revisions chain off the
        // activeAssetId directly. Uploaded-file in-place edits chain via the
        // editedFileRef session-store key. Plain generation is standalone v1.
        const lineage =
          activeAssetId && layoutEditResult
            ? await getNextVersionLineageFromAssetId(authed.userId, activeAssetId)
            : result.editedFileRef
              ? await getNextVersionLineage(authed.userId, result.editedFileRef)
              : null;
        const isRevision = activeAssetId && layoutEditResult;
        const editSummary =
          isRevision || result.editedFileRef
            ? (result.editQuality?.changes?.length
                ? result.editQuality.changes.join("; ")
                : `Revised: ${message}`
              ).slice(0, 300)
            : null;
        assetId = await persistOraAsset({
          userId: authed.userId,
          // Chained versions inherit the parent's project via the lineage
          // spread below; only a standalone v1 uses this request's project.
          oraProjectId: libraryProjectId,
          kind: "file",
          fileName: result.fileName,
          mimeType: result.mimeType,
          format,
          prompt: message,
          base64: result.fileData,
          ...(lineage ?? {}),
          sourceFileRef: result.editedFileRef ?? null,
          editSummary,
        });
        // Surface the persisted version on the quality card so clients can
        // open revision history directly from it.
        if (assetId != null && result.editQuality) {
          result.editQuality.versionId = assetId;
        }
        // In-place Office edit on an uploaded file: repoint the durable
        // file-context mirror at the edited asset so revisions after a
        // restart/rotated session compound instead of reverting to the upload.
        if (assetId != null && result.editedFileRef) {
          const { relinkDurableFileContextBestEffort } =
            await import("../../lib/public-ai/file-context-store");
          relinkDurableFileContextBestEffort({
            fileRef: result.editedFileRef,
            sessionId: session.sessionId,
            userId: authed.userId,
            assetId,
          });
        }
      } catch (assetErr) {
        // Durable-library persistence is a bonus, not a requirement. A failure
        // here (DB/R2/library outage) must never break file creation: keep
        // assetId null and still return the freshly generated inline bytes, which
        // remain downloadable for this session. Do NOT fall through to the outer
        // catch (that refunds quota and 500s a file the user actually received).
        logger.warn(
          { component: "ora-generate-file", format, err: assetErr },
          "Durable asset persistence failed; returning inline file without assetId",
        );
      }
    }

    const { token, payload } = incrementMessageCount(session);
    setSessionCookie(res, token);

    logger.info(
      {
        component: "ora-generate-file",
        format,
        fileName: result.fileName,
        bytes: Buffer.from(result.fileData, "base64").length,
      },
      "File generated",
    );

    const usage = await oraMessageFields(authed, payload.msgCount);
    const fileAgentPreview = buildFileAgentPreview({
      format,
      fileName: result.fileName,
      hasSourceData,
      sourceCount: documentRefs.length,
      editQuality: result.editQuality,
      usedFiles: multiFilePlan?.usedFiles,
    });
    res.json({
      reply: result.reply,
      fileName: result.fileName,
      fileData: result.fileData,
      mimeType: result.mimeType,
      ...(assetId != null ? { assetId } : {}),
      ...(result.editQuality ? { editQuality: result.editQuality } : {}),
      fileAgentPreview,
      ...(multiFilePlan ? { usedFiles: multiFilePlan.usedFiles } : {}),
      // Live activity trace terminal step (no SSE on this route; clients
      // synthesize the "start" step when they kick off the generation).
      activity: [oraActivityStep("file-generation", "ok")],
      ...usage,
    });
  } catch (err) {
    if (authed) await refundOraQuota(authed.userId, "message");
    logger.error({ component: "ora-generate-file", format, err }, "File generation failed");
    const failActivity = [oraActivityStep("file-generation", "fail")];
    // FileGenerationError carries a user-safe message (e.g. the model lost the
    // attached data) — surface it instead of the generic 500 fallback.
    if (FileGenerationErrorCtor && err instanceof FileGenerationErrorCtor) {
      res.status(422).json({ error: err.message, activity: failActivity });
    } else {
      res
        .status(500)
        .json({ error: "Failed to generate file. Please try again.", activity: failActivity });
    }
  }
});

export default router;

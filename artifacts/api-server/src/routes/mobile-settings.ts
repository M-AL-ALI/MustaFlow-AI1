import { Router, type IRouter } from "express";
import { and, eq, sql } from "drizzle-orm";
import {
  db,
  projectFilesTable,
  projectsTable,
  agentTasksTable,
  taskEventsTable,
} from "@workspace/db";
import { requireProjectOwnership } from "../lib/auth";
import { z } from "zod";
import { logger } from "../lib/logger";
import { writeProjectFilesAtomically } from "../lib/project-file-writer";
import { emitTaskEventBounded } from "../lib/task-event-emission";
import { saveMobileSettingsWithMetadata } from "../lib/mobile-settings-outcome";

const router: IRouter = Router();

const MOBILE_KINDS = new Set(["mobile-ios", "mobile-android", "mobile-cross"]);

const BUNDLE_ID_RE = /^[a-zA-Z][a-zA-Z0-9]*(\.[a-zA-Z][a-zA-Z0-9]*){1,}$/;

const MobileAppSettingsInputSchema = z.object({
  appName: z.string().min(1, "App name is required").optional(),
  bundleId: z
    .string()
    .regex(BUNDLE_ID_RE, "Bundle ID must be reverse-domain format, e.g. com.company.appname")
    .optional(),
  packageName: z
    .string()
    .regex(BUNDLE_ID_RE, "Package name must be reverse-domain format, e.g. com.company.appname")
    .optional(),
  version: z.string().min(1, "Version is required").optional(),
  splashBackgroundColor: z
    .string()
    .regex(/^#([0-9a-fA-F]{3}|[0-9a-fA-F]{6})$/, "Must be a valid hex color, e.g. #ffffff")
    .optional(),
  iconBase64: z.string().optional(),
});

/** Emit a task event (best-effort, non-fatal). */
async function emitEvent(
  taskId: number,
  eventType: string,
  message: string,
  filePath?: string,
): Promise<void> {
  await emitTaskEventBounded({
    persist: async () => {
      await db.insert(taskEventsTable).values({
        taskId,
        eventType,
        message,
        filePath: filePath ?? null,
      });
      return null;
    },
    publish: () => undefined,
    recordDrop: (drop) => {
      logger.warn({ taskId, eventType, drop }, "Mobile-settings task event observation dropped");
    },
  });
}

/** Read and parse app.json for a project; returns null if absent or invalid. */
async function readAppJson(
  projectId: number,
): Promise<{ row: typeof projectFilesTable.$inferSelect; expo: Record<string, unknown> } | null> {
  const [fileRow] = await db
    .select()
    .from(projectFilesTable)
    .where(and(eq(projectFilesTable.projectId, projectId), eq(projectFilesTable.path, "app.json")));
  if (!fileRow) return null;
  try {
    const appJson = JSON.parse(fileRow.content) as Record<string, unknown>;
    const expo = (appJson.expo ?? {}) as Record<string, unknown>;
    return { row: fileRow, expo };
  } catch {
    return null;
  }
}

/** Extract current settings from a parsed expo object. */
function expoToSettings(expo: Record<string, unknown>, projectId: number) {
  const iconPath = (expo.icon as string | undefined) ?? "./assets/icon.png";
  const iconUrl = `/api/projects/${projectId}/preview/${iconPath.replace(/^\.\//, "")}`;
  return {
    appName: String(expo.name ?? ""),
    bundleId: String(((expo.ios ?? {}) as Record<string, unknown>).bundleIdentifier ?? ""),
    packageName: String(((expo.android ?? {}) as Record<string, unknown>).package ?? ""),
    version: String(expo.version ?? ""),
    splashBackgroundColor: String(
      ((expo.splash ?? {}) as Record<string, unknown>).backgroundColor ?? "#ffffff",
    ),
    iconUrl: expo.icon ? iconUrl : null,
    taskId: null as number | null,
  };
}

// ── GET /projects/:id/mobile-settings ────────────────────────────────────────

router.get(
  "/projects/:id/mobile-settings",
  requireProjectOwnership,
  async (req, res): Promise<void> => {
    const projectId = Number(req.params.id);
    if (!Number.isFinite(projectId)) {
      res.status(400).json({ error: "Invalid project id" });
      return;
    }

    const [project] = await db
      .select({ id: projectsTable.id, kind: projectsTable.kind })
      .from(projectsTable)
      .where(and(eq(projectsTable.id, projectId), sql`${projectsTable.deletedAt} IS NULL`));

    if (!project) {
      res.status(404).json({ error: "Project not found" });
      return;
    }

    if (!MOBILE_KINDS.has(project.kind)) {
      res.status(400).json({ error: "Project is not a mobile project" });
      return;
    }

    const appJson = await readAppJson(projectId);
    if (!appJson) {
      res.json({
        appName: "",
        bundleId: "",
        packageName: "",
        version: "",
        splashBackgroundColor: "#ffffff",
        iconUrl: null,
        taskId: null,
      });
      return;
    }

    res.json(expoToSettings(appJson.expo, projectId));
  },
);

// ── POST /projects/:id/mobile-settings ───────────────────────────────────────

router.post(
  "/projects/:id/mobile-settings",
  requireProjectOwnership,
  async (req, res): Promise<void> => {
    const projectId = Number(req.params.id);
    if (!Number.isFinite(projectId)) {
      res.status(400).json({ error: "Invalid project id" });
      return;
    }

    const parsed = MobileAppSettingsInputSchema.safeParse(req.body);
    if (!parsed.success) {
      const first = parsed.error.errors[0];
      res.status(400).json({ error: first?.message ?? "Invalid input" });
      return;
    }

    const [project] = await db
      .select({
        id: projectsTable.id,
        kind: projectsTable.kind,
        name: projectsTable.name,
        ownerId: projectsTable.ownerId,
      })
      .from(projectsTable)
      .where(and(eq(projectsTable.id, projectId), sql`${projectsTable.deletedAt} IS NULL`));

    if (!project) {
      res.status(404).json({ error: "Project not found" });
      return;
    }

    if (!MOBILE_KINDS.has(project.kind)) {
      res.status(400).json({ error: "Project is not a mobile project" });
      return;
    }

    const { appName, bundleId, packageName, version, splashBackgroundColor, iconBase64 } =
      parsed.data;

    // ── Create an AgentTask to track this change in Build History ─────────────
    const changedFields: string[] = [];
    if (appName) changedFields.push("app name");
    if (bundleId) changedFields.push("bundle ID");
    if (packageName) changedFields.push("package name");
    if (version) changedFields.push("version");
    if (splashBackgroundColor) changedFields.push("splash color");
    if (iconBase64) changedFields.push("app icon");
    const changeDescription =
      changedFields.length > 0
        ? `App settings updated: ${changedFields.join(", ")}`
        : "App settings saved (no fields changed)";

    const [task] = await db
      .insert(agentTasksTable)
      .values({
        projectId,
        title: `Settings: ${changeDescription.slice(0, 80)}`,
        kind: "main",
        status: "planning",
        prompt: changeDescription,
      })
      .returning();

    const taskId = task?.id ?? 0;

    try {
      await emitEvent(taskId, "queued", "Applying mobile app settings…");

      // ── Build the list of files to write ───────────────────────────────────
      const filesToWrite: Array<{ path: string; content: string; mimeType: string }> = [];

      // Read or initialise app.json
      const appJsonResult = await readAppJson(projectId);
      const expo: Record<string, unknown> = appJsonResult?.expo ?? {};
      const appJson: Record<string, unknown> = appJsonResult
        ? (JSON.parse(appJsonResult.row.content) as Record<string, unknown>)
        : { expo: {} };

      if (appName !== undefined) {
        expo.name = appName;
        expo.slug = appName
          .toLowerCase()
          .replace(/\s+/g, "-")
          .replace(/[^a-z0-9-]/g, "");
      }

      if (version !== undefined) {
        expo.version = version;
      }

      if (bundleId !== undefined) {
        const ios = (expo.ios ?? {}) as Record<string, unknown>;
        ios.bundleIdentifier = bundleId;
        expo.ios = ios;
      }

      if (packageName !== undefined) {
        const android = (expo.android ?? {}) as Record<string, unknown>;
        android.package = packageName;
        expo.android = android;
      }

      if (splashBackgroundColor !== undefined) {
        const splash = (expo.splash ?? {}) as Record<string, unknown>;
        splash.backgroundColor = splashBackgroundColor;
        expo.splash = splash;
      }

      // ── Icon upload ─────────────────────────────────────────────────────────
      if (iconBase64) {
        await emitEvent(taskId, "editing_files", "Processing app icon upload…");
        const iconContent = iconBase64.replace(/^data:[^;]+;base64,/, "");
        // Validate PNG magic bytes (base64 of \x89PNG\r\n\x1a\n starts with "iVBORw0KGgo")
        if (!iconContent.startsWith("iVBORw0KGgo")) {
          res.status(400).json({ error: "Icon must be a valid PNG file." });
          return;
        }
        filesToWrite.push({
          path: "assets/icon.png",
          content: iconContent,
          mimeType: "image/png",
        });
        expo.icon = "./assets/icon.png";
        // Also set as adaptive icon for completeness
        const androidAdaptiveIcon = (expo.android ?? {}) as Record<string, unknown>;
        const adaptiveIcon = (androidAdaptiveIcon.adaptiveIcon ?? {}) as Record<string, unknown>;
        adaptiveIcon.foregroundImage = "./assets/icon.png";
        adaptiveIcon.backgroundColor = splashBackgroundColor ?? "#ffffff";
        androidAdaptiveIcon.adaptiveIcon = adaptiveIcon;
        expo.android = androidAdaptiveIcon;
      }

      appJson.expo = expo;
      const updatedAppJsonContent = JSON.stringify(appJson, null, 2);
      filesToWrite.push({
        path: "app.json",
        content: updatedAppJsonContent,
        mimeType: "application/json",
      });

      // ── Emit file-editing events ────────────────────────────────────────────
      for (const f of filesToWrite) {
        await emitEvent(taskId, "editing_files", `Updating ${f.path}`, f.path);
      }

      // ── Write files and a version together; metadata cannot reverse that outcome ──
      await emitEvent(taskId, "saving_version", "Saving rollback snapshot…");
      const updatedSettings = expoToSettings(expo, projectId);

      async function commitFilesAndVersion() {
        await writeProjectFilesAtomically({
          projectId,
          scope: { kind: "project" },
          replaceAll: false,
          files: filesToWrite,
          authoritativeVersion: {
            label: `Settings: ${changedFields.join(", ") || "no changes"}`,
            note: changeDescription,
            changelogEntry: changeDescription,
          },
        });
        return updatedSettings;
      }

      const savedSettings = await saveMobileSettingsWithMetadata({
        commitFilesAndVersion,
        metadata: [
          {
            stage: "task_completion",
            write: () =>
              db
                .update(agentTasksTable)
                .set({
                  status: "completed",
                  result: changeDescription,
                  completedAt: sql`now()`,
                })
                .where(eq(agentTasksTable.id, taskId)),
          },
          {
            stage: "project_touch",
            write: () =>
              db
                .update(projectsTable)
                .set({ updatedAt: sql`now()` })
                .where(eq(projectsTable.id, projectId)),
          },
          {
            stage: "completion_event",
            write: () => emitEvent(taskId, "completed", "App settings saved."),
          },
        ],
        recordFailure: (failure) => {
          logger.warn(
            { projectId, taskId, failure },
            "Mobile-settings post-commit metadata degraded",
          );
        },
      });

      res.json({ ...savedSettings, taskId });
    } catch (err) {
      logger.error({ err, projectId, taskId }, "Failed to apply mobile settings");
      await emitEvent(taskId, "failed", err instanceof Error ? err.message : "Unknown error");
      await db
        .update(agentTasksTable)
        .set({
          status: "failed",
          result: err instanceof Error ? err.message : "Failed to apply settings",
          completedAt: sql`now()`,
        })
        .where(eq(agentTasksTable.id, taskId));
      res
        .status(500)
        .json({ error: err instanceof Error ? err.message : "Failed to apply settings" });
    }
  },
);

export default router;

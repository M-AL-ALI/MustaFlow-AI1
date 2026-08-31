// ─────────────────────────────────────────────────────────────────────────────
// EAS Build integration routes
//
// POST /api/projects/:id/eas/validate-token — validate & store EAS PAT as secret
// GET  /api/projects/:id/eas/builds         — list EAS build entries from deployment_logs
// POST /api/projects/:id/eas/trigger        — trigger a real EAS build via GraphQL API
// POST /api/projects/:id/eas/builds         — link an existing build by ID or exp:// URL
// PATCH /api/projects/:id/eas/builds/:logId — poll EAS API and refresh build status
// ─────────────────────────────────────────────────────────────────────────────

import { Router, type IRouter } from "express";
import { and, desc, eq, like } from "drizzle-orm";
import { db, deploymentLogsTable, secretsTable, projectFilesTable } from "@workspace/db";
import { requireProjectOwnership } from "../lib/auth";
import { encryptionService } from "../lib/encryption";
import { logger } from "../lib/logger";
import { requireActiveProjectLifecycleSession } from "../lib/project-lifecycle";

const router: IRouter = Router();

// ── Constants ─────────────────────────────────────────────────────────────────

const EAS_API = "https://api.expo.dev";
const EAS_GQL = `${EAS_API}/graphql`;

// ── Helpers ───────────────────────────────────────────────────────────────────

async function fetchEasUserInfo(token: string): Promise<{ username: string; id: string } | null> {
  try {
    const res = await fetch(`${EAS_API}/v2/auth/userinfo`, {
      headers: { Authorization: `Bearer ${token}` },
    });
    if (!res.ok) return null;
    const data = (await res.json()) as { data?: { username?: string; id?: string } };
    const username = data?.data?.username;
    const id = data?.data?.id;
    if (!username || !id) return null;
    return { username, id };
  } catch {
    return null;
  }
}

async function easGql<T>(
  token: string,
  query: string,
  variables: Record<string, unknown>,
): Promise<T | null> {
  try {
    const res = await fetch(EAS_GQL, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${token}`,
      },
      body: JSON.stringify({ query, variables }),
    });
    if (!res.ok) return null;
    const json = (await res.json()) as { data?: T; errors?: unknown[] };
    if (json.errors?.length) return null;
    return json.data ?? null;
  } catch {
    return null;
  }
}

async function fetchEasAppId(
  token: string,
  fullName: string, // "@owner/slug"
): Promise<string | null> {
  type AppData = { app: { byFullName: { id: string } | null } };
  const data = await easGql<AppData>(
    token,
    `query GetApp($fullName: String!) {
       app { byFullName(fullName: $fullName) { id } }
     }`,
    { fullName },
  );
  return data?.app?.byFullName?.id ?? null;
}

type EasBuildData = {
  id: string;
  status: string;
  platform: string;
  logsPageUrl: string | null;
  artifacts: { buildUrl: string | null } | null;
  expirationDate: string | null;
};

async function fetchLogSnippet(token: string, easBuildId: string): Promise<string | null> {
  try {
    const res = await fetch(`${EAS_API}/v2/builds/${easBuildId}/logs`, {
      headers: { Authorization: `Bearer ${token}` },
    });
    if (!res.ok) return null;
    const text = await res.text();
    if (!text.trim()) return null;
    const lines = text.split("\n");
    // Keep first 50 lines; trim trailing blank lines
    const snippet = lines.slice(0, 50).join("\n").trimEnd();
    return snippet || null;
  } catch {
    return null;
  }
}

async function triggerEasGqlBuild(
  token: string,
  appId: string,
  platform: "IOS" | "ANDROID",
  profile = "preview",
): Promise<EasBuildData | null> {
  // EAS uses separate mutations per platform
  const mutation =
    platform === "ANDROID"
      ? `mutation TriggerAndroid($appId: String!, $profile: String) {
           build(appId: $appId, platform: ANDROID, profile: $profile) {
             id status platform logsPageUrl
             artifacts { buildUrl }
             expirationDate
           }
         }`
      : `mutation TriggerIOS($appId: String!, $profile: String) {
           build(appId: $appId, platform: IOS, profile: $profile) {
             id status platform logsPageUrl
             artifacts { buildUrl }
             expirationDate
           }
         }`;
  const data = await easGql<{ build: EasBuildData }>(token, mutation, { appId, profile });
  return data?.build ?? null;
}

async function pollEasBuild(token: string, easBuildId: string): Promise<EasBuildData | null> {
  type BuildQuery = { build: { byId: EasBuildData | null } };
  const data = await easGql<BuildQuery>(
    token,
    `query GetBuild($id: ID!) {
       build { byId(id: $id) {
         id status platform logsPageUrl
         artifacts { buildUrl }
         expirationDate
       }}
     }`,
    { id: easBuildId },
  );
  // Fall back to REST API if GraphQL is unavailable
  if (!data?.build?.byId) {
    try {
      const res = await fetch(`${EAS_API}/v2/builds/${easBuildId}`, {
        headers: { Authorization: `Bearer ${token}` },
      });
      if (!res.ok) return null;
      const rest = (await res.json()) as {
        data?: {
          status?: string;
          platform?: string;
          logsPageUrl?: string;
          artifacts?: { buildUrl?: string; logsUrl?: string; applicationArchiveUrl?: string };
          expirationDate?: string;
          // Some EAS API versions surface the logs page URL at top level
          buildPageUrl?: string;
        };
      };
      const b = rest.data;
      if (!b) return null;
      // Prefer explicit logsPageUrl, fall back to buildPageUrl or construct from known expo.dev path
      const restLogsUrl =
        b.logsPageUrl ?? b.buildPageUrl ?? `https://expo.dev/builds/${easBuildId}`;
      return {
        id: easBuildId,
        status: b.status ?? "unknown",
        platform: b.platform ?? "unknown",
        logsPageUrl: restLogsUrl,
        artifacts: b.artifacts
          ? { buildUrl: b.artifacts.buildUrl ?? b.artifacts.applicationArchiveUrl ?? null }
          : null,
        expirationDate: b.expirationDate ?? null,
      };
    } catch {
      return null;
    }
  }
  return data.build.byId;
}

async function getEasTokenForProject(projectId: number): Promise<string | null> {
  const [row] = await db
    .select()
    .from(secretsTable)
    .where(and(eq(secretsTable.projectId, projectId), eq(secretsTable.name, "EAS_ACCESS_TOKEN")))
    .limit(1);
  if (!row) return null;
  try {
    return encryptionService.decrypt(row.valueEncrypted);
  } catch {
    return null;
  }
}

async function getAppJson(
  projectId: number,
): Promise<{ slug: string; name: string; owner?: string } | null> {
  const [row] = await db
    .select()
    .from(projectFilesTable)
    .where(and(eq(projectFilesTable.projectId, projectId), eq(projectFilesTable.path, "app.json")))
    .limit(1);
  if (!row) return null;
  try {
    const parsed = JSON.parse(row.content) as {
      expo?: { slug?: string; name?: string; owner?: string };
    };
    const slug = parsed?.expo?.slug;
    if (!slug) return null;
    return {
      slug,
      name: parsed.expo?.name ?? slug,
      owner: parsed.expo?.owner ?? undefined,
    };
  } catch {
    return null;
  }
}

const DEFAULT_EAS_JSON = JSON.stringify(
  {
    cli: { version: ">= 16.0.0" },
    build: {
      preview: { distribution: "internal" },
      production: { autoIncrement: true },
    },
  },
  null,
  2,
);

async function hasEasJson(projectId: number): Promise<boolean> {
  const [row] = await db
    .select({ path: projectFilesTable.path })
    .from(projectFilesTable)
    .where(and(eq(projectFilesTable.projectId, projectId), eq(projectFilesTable.path, "eas.json")))
    .limit(1);
  return !!row;
}

async function ensureEasJson(projectId: number): Promise<void> {
  // Atomic insert — the unique (projectId, path) constraint means onConflictDoNothing
  // is safe under concurrent requests; no check-then-insert race.
  const result = await db
    .insert(projectFilesTable)
    .values({
      projectId,
      path: "eas.json",
      content: DEFAULT_EAS_JSON,
      mimeType: "application/json",
    })
    .onConflictDoNothing()
    .returning({ id: projectFilesTable.id });
  if (result.length > 0) {
    logger.info({ projectId }, "Auto-generated eas.json for project");
  }
}

// Map EAS status strings → our deployment_logs status
function easStatusToLogStatus(easStatus: string): "started" | "passed" | "failed" {
  const lower = easStatus.toLowerCase();
  if (["finished", "completed"].includes(lower)) return "passed";
  if (["errored", "expired", "cancelled", "canceled"].includes(lower)) return "failed";
  return "started";
}

// ── POST /api/projects/:id/eas/validate-token ─────────────────────────────────
router.post(
  "/projects/:id/eas/validate-token",
  requireProjectOwnership,
  requireActiveProjectLifecycleSession,
  async (req, res): Promise<void> => {
    const projectId = Number(req.params.id);
    if (!Number.isFinite(projectId)) {
      res.status(400).json({ error: "Invalid project id" });
      return;
    }

    const { token } = req.body as { token?: string };
    if (!token?.trim()) {
      res.status(400).json({ error: "token is required" });
      return;
    }

    const userInfo = await fetchEasUserInfo(token.trim());
    if (!userInfo) {
      res.status(422).json({ error: "Invalid EAS token — could not authenticate with Expo." });
      return;
    }

    // Upsert token as encrypted project secret
    const encrypted = encryptionService.encrypt(token.trim());
    const existing = await db
      .select()
      .from(secretsTable)
      .where(and(eq(secretsTable.projectId, projectId), eq(secretsTable.name, "EAS_ACCESS_TOKEN")))
      .limit(1);

    if (existing.length > 0 && existing[0]) {
      await db
        .update(secretsTable)
        .set({ valueEncrypted: encrypted, updatedAt: new Date() })
        .where(eq(secretsTable.id, existing[0].id));
    } else {
      await db.insert(secretsTable).values({
        projectId,
        name: "EAS_ACCESS_TOKEN",
        valueEncrypted: encrypted,
        environment: "production",
        category: "api_key",
      });
    }

    const appInfo = await getAppJson(projectId);
    res.json({
      ok: true,
      username: userInfo.username,
      accountId: userInfo.id,
      appSlug: appInfo?.slug ?? null,
      appName: appInfo?.name ?? null,
    });
  },
);

// ── POST /api/projects/:id/eas/trigger ───────────────────────────────────────
// Trigger a real EAS build via the EAS GraphQL API.
// Prerequisites: EAS_ACCESS_TOKEN secret, app.json with slug + owner field.
// Creates a deployment_log entry (env="eas-ios"/"eas-android", status="started").
router.post(
  "/projects/:id/eas/trigger",
  requireProjectOwnership,
  requireActiveProjectLifecycleSession,
  async (req, res): Promise<void> => {
    const projectId = Number(req.params.id);
    if (!Number.isFinite(projectId)) {
      res.status(400).json({ error: "Invalid project id" });
      return;
    }

    const body = req.body as { platform?: "ios" | "android"; profile?: string };
    const platform = body.platform ?? "android";
    const profile = body.profile ?? "preview";
    const env = `eas-${platform}`;

    // 1. Get EAS token
    const token = await getEasTokenForProject(projectId);
    if (!token) {
      res.status(422).json({
        error: "EAS_ACCESS_TOKEN not configured. Save your token in the EAS Token section first.",
      });
      return;
    }

    // 2. Get user info
    const userInfo = await fetchEasUserInfo(token);
    if (!userInfo) {
      res.status(422).json({ error: "EAS token is invalid or expired. Please update it." });
      return;
    }

    // 3. Read app.json to get slug + owner
    const appInfo = await getAppJson(projectId);
    if (!appInfo?.slug) {
      res.status(422).json({
        error: "app.json is missing or has no 'slug'. Build the project first, then try again.",
      });
      return;
    }

    const owner = appInfo.owner ?? userInfo.username;
    const fullName = `@${owner}/${appInfo.slug}`;

    // 4. Auto-generate eas.json if it's missing — prevents "profile does not exist" errors
    await ensureEasJson(projectId);

    // 5. Look up the EAS app ID
    const easAppId = await fetchEasAppId(token, fullName);
    if (!easAppId) {
      res.status(422).json({
        error: `EAS app "${fullName}" not found. Run \`eas init\` in your project directory to register it with EAS first.`,
        hint: "eas_init_required",
        fullName,
        cliCommand: `EXPO_TOKEN=<token> eas init --id <your-project-id>`,
      });
      return;
    }

    // 6. Trigger the build via GraphQL
    const gqlPlatform = platform === "ios" ? "IOS" : "ANDROID";
    const buildResult = await triggerEasGqlBuild(token, easAppId, gqlPlatform, profile);
    if (!buildResult) {
      // Record as a failed trigger attempt so user can see it in deployment logs
      await db.insert(deploymentLogsTable).values({
        projectId,
        userId: req.userId ?? "unknown",
        env,
        status: "failed",
        note: `EAS build trigger failed for ${fullName} (${platform}, profile: ${profile})`,
        checksResult: { fullName, profile, reason: "graphql_trigger_failed" },
      });
      res.status(502).json({
        error:
          "EAS build trigger failed. The app may not be registered with EAS yet — run `eas init` in your exported project folder and try again.",
        hint: "eas_init_required",
      });
      return;
    }

    // 6. Persist in deployment_logs so it appears in the Deployment Logs tab
    const logsUrl =
      buildResult.logsPageUrl ??
      `https://expo.dev/accounts/${owner}/projects/${appInfo.slug}/builds/${buildResult.id}`;
    const [log] = await db
      .insert(deploymentLogsTable)
      .values({
        projectId,
        userId: req.userId ?? "unknown",
        env,
        status: easStatusToLogStatus(buildResult.status),
        publicUrl: buildResult.artifacts?.buildUrl ?? null,
        note: `EAS ${platform} build triggered (profile: ${profile})`,
        checksResult: {
          easBuildId: buildResult.id,
          easStatus: buildResult.status,
          logsPageUrl: logsUrl,
          fullName,
          profile,
          expirationDate: buildResult.expirationDate,
        },
      })
      .returning();

    logger.info(
      { projectId, easBuildId: buildResult.id, platform, profile, status: buildResult.status },
      "EAS build triggered",
    );

    res.status(201).json({
      id: log?.id,
      easBuildId: buildResult.id,
      env,
      status: log?.status ?? easStatusToLogStatus(buildResult.status),
      logsPageUrl: logsUrl,
      note: log?.note,
      createdAt: log?.createdAt,
    });
  },
);

// ── GET /api/projects/:id/eas/builds ─────────────────────────────────────────
router.get("/projects/:id/eas/builds", requireProjectOwnership, async (req, res): Promise<void> => {
  const projectId = Number(req.params.id);
  if (!Number.isFinite(projectId)) {
    res.status(400).json({ error: "Invalid project id" });
    return;
  }

  const rows = await db
    .select()
    .from(deploymentLogsTable)
    .where(
      and(eq(deploymentLogsTable.projectId, projectId), like(deploymentLogsTable.env, "eas-%")),
    )
    .orderBy(desc(deploymentLogsTable.createdAt))
    .limit(20);

  const hasToken = !!(await getEasTokenForProject(projectId));
  const appInfo = await getAppJson(projectId);
  const easJsonPresent = await hasEasJson(projectId);

  res.json({
    hasToken,
    hasEasJson: easJsonPresent,
    appSlug: appInfo?.slug ?? null,
    appName: appInfo?.name ?? null,
    builds: rows.map((r) => {
      const meta = (r.checksResult ?? {}) as Record<string, unknown>;
      return {
        id: r.id,
        env: r.env,
        status: r.status,
        publicUrl: r.publicUrl,
        note: r.note,
        createdAt: r.createdAt,
        easBuildId: (meta.easBuildId as string) ?? null,
        logsPageUrl: (meta.logsPageUrl as string) ?? null,
        easStatus: (meta.easStatus as string) ?? null,
        logSnippet: (meta.logSnippet as string) ?? null,
      };
    }),
  });
});

// ── POST /api/projects/:id/eas/builds ─────────────────────────────────────────
// Link an existing EAS build by ID (polls EAS API) or by a direct exp:// / download URL.
router.post(
  "/projects/:id/eas/builds",
  requireProjectOwnership,
  requireActiveProjectLifecycleSession,
  async (req, res): Promise<void> => {
    const projectId = Number(req.params.id);
    if (!Number.isFinite(projectId)) {
      res.status(400).json({ error: "Invalid project id" });
      return;
    }

    const body = req.body as { platform?: "ios" | "android"; easBuildId?: string; expUrl?: string };
    const platform = body.platform ?? "android";
    const env = `eas-${platform}`;

    let status: "started" | "passed" | "failed" = "started";
    let publicUrl: string | null = null;
    let note: string | null = null;
    const checksResult: Record<string, unknown> = {};

    if (body.expUrl?.trim()) {
      publicUrl = body.expUrl.trim();
      status = "passed";
      note = `User-supplied URL for ${platform}`;
    } else if (body.easBuildId?.trim()) {
      checksResult.easBuildId = body.easBuildId.trim();
      const token = await getEasTokenForProject(projectId);
      if (token) {
        const build = await pollEasBuild(token, body.easBuildId.trim());
        if (build) {
          status = easStatusToLogStatus(build.status);
          publicUrl = build.artifacts?.buildUrl ?? null;
          note = `EAS Build ${build.status} (${build.platform})`;
          checksResult.easStatus = build.status;
          checksResult.expirationDate = build.expirationDate;
          if (build.logsPageUrl) checksResult.logsPageUrl = build.logsPageUrl;
        }
      }
      note = note ?? `EAS Build ID: ${body.easBuildId.trim()}`;
    } else {
      note = `EAS ${platform} build (linked)`;
    }

    const [log] = await db
      .insert(deploymentLogsTable)
      .values({
        projectId,
        userId: req.userId ?? "unknown",
        env,
        status,
        publicUrl,
        note,
        checksResult: Object.keys(checksResult).length > 0 ? checksResult : null,
      })
      .returning();

    if (!log) {
      res.status(500).json({ error: "Failed to create build log entry" });
      return;
    }

    res.status(201).json({
      id: log.id,
      env: log.env,
      status: log.status,
      publicUrl: log.publicUrl,
      note: log.note,
      easBuildId: (log.checksResult as Record<string, unknown> | null)?.easBuildId ?? null,
      createdAt: log.createdAt,
    });
  },
);

// ── PATCH /api/projects/:id/eas/builds/:logId ─────────────────────────────────
// Poll EAS API for updated build status and persist the changes.
router.patch(
  "/projects/:id/eas/builds/:logId",
  requireProjectOwnership,
  requireActiveProjectLifecycleSession,
  async (req, res): Promise<void> => {
    const projectId = Number(req.params.id);
    const logId = Number(req.params.logId);
    if (!Number.isFinite(projectId) || !Number.isFinite(logId)) {
      res.status(400).json({ error: "Invalid id" });
      return;
    }

    const [existing] = await db
      .select()
      .from(deploymentLogsTable)
      .where(and(eq(deploymentLogsTable.id, logId), eq(deploymentLogsTable.projectId, projectId)))
      .limit(1);

    if (!existing) {
      res.status(404).json({ error: "Build log not found" });
      return;
    }

    const meta = (existing.checksResult ?? {}) as Record<string, unknown>;
    const easBuildId = meta.easBuildId as string | undefined;

    if (!easBuildId) {
      res.json({
        id: existing.id,
        status: existing.status,
        publicUrl: existing.publicUrl,
        note: existing.note,
      });
      return;
    }

    const token = await getEasTokenForProject(projectId);
    if (!token) {
      res.status(422).json({ error: "EAS_ACCESS_TOKEN not configured for this project" });
      return;
    }

    const build = await pollEasBuild(token, easBuildId);
    if (!build) {
      res.json({
        id: existing.id,
        status: existing.status,
        publicUrl: existing.publicUrl,
        note: existing.note,
        pollError: "Could not reach EAS API",
      });
      return;
    }

    const newStatus = easStatusToLogStatus(build.status);
    // Store the artifact download URL (APK/IPA). Users can also paste an exp:// URL via the link form.
    const newPublicUrl = build.artifacts?.buildUrl ?? existing.publicUrl;
    const logsPageUrl = build.logsPageUrl ?? (meta.logsPageUrl as string | undefined);
    const newNote = `EAS Build ${build.status} (${build.platform})`;

    // Fetch log snippet when build has finished (pass or fail), if we don't have one yet,
    // or when the caller explicitly requests a refresh via ?force=1.
    const forceRefresh = req.query.force === "1" || req.query.force === "true";
    const existingSnippet = meta.logSnippet as string | undefined;
    let logSnippet = existingSnippet ?? null;
    const isFinal = ["passed", "failed"].includes(newStatus);
    if (isFinal && (!existingSnippet || forceRefresh)) {
      logSnippet = await fetchLogSnippet(token, easBuildId);
    }

    const updatedMeta = {
      ...meta,
      easStatus: build.status,
      expirationDate: build.expirationDate,
      ...(logsPageUrl ? { logsPageUrl } : {}),
      ...(logSnippet ? { logSnippet } : {}),
    };

    const [updated] = await db
      .update(deploymentLogsTable)
      .set({ status: newStatus, publicUrl: newPublicUrl, note: newNote, checksResult: updatedMeta })
      .where(eq(deploymentLogsTable.id, logId))
      .returning();

    logger.info(
      { projectId, logId, easBuildId, easStatus: build.status },
      "EAS build status refreshed",
    );

    res.json({
      id: updated?.id ?? logId,
      status: updated?.status ?? newStatus,
      publicUrl: updated?.publicUrl ?? newPublicUrl,
      logsPageUrl: logsPageUrl ?? null,
      logSnippet: logSnippet ?? null,
      note: updated?.note ?? newNote,
      easBuildId,
      easStatus: build.status,
    });
  },
);

export default router;

import { Router, type IRouter } from "express";
import healthRouter from "./health";
import projectsRouter from "./projects";
import messagesRouter from "./messages";
import tasksRouter from "./tasks";
import versionsRouter from "./versions";
import checkpointsRouter from "./checkpoints";
import workflowsRouter from "./workflows";
import visualEditRouter from "./visual-edit";
import secretsRouter from "./secrets";
import knowledgeRouter from "./knowledge";
import vaultRouter from "./vault";
import vaultEmbeddingsRouter from "./vault-embeddings";
import vaultSearchRouter from "./vault-search";
import activityRouter from "./activity";
import filesRouter from "./files";
import eventsRouter from "./events";
import agentPromptsRouter from "./agent-prompts";
import exportRouter from "./export";
import duplicateRouter from "./duplicate";
import publishRouter from "./publish";
import publicRouter from "./public";
import readinessRouter from "./readiness";
import deploymentsRouter from "./deployments";
import creditsRouter from "./credits";
import domainsRouter from "./domains";
import dnsRecordsRouter from "./dns-records";
import sslRouter, { sslWebhookRouter } from "./ssl";
import pageMapRouter from "./page-map";
import blocksRouter from "./blocks";
import mobileSettingsRouter from "./mobile-settings";
import adminRouter from "./admin";
import adminOraRoutingDiagnosticsRouter from "./admin-ora-routing-diagnostics";
import adminOraMonitoringRouter from "./admin-ora-monitoring";
import adminSupportRouter from "./admin-support";
import billingRouter, { billingWebhookRouter, billingPublicRouter } from "./billing";
import workspacesRouter from "./workspaces";
import workspaceDomainsRouter from "./workspace-domains";
import buildsRouter from "./builds";
import queueRouter from "./queue";
import easRouter from "./eas";
import signingRouter from "./signing";
import analyticsRouter from "./analytics";
import auditRouter from "./audit";
import suggestionsRouter from "./suggestions";
import githubRouter from "./github";
import subdomainRouter from "./subdomain";
import containersRouter from "./containers";
import deployRouter from "./deploy";
import packagesRouter from "./packages";
import databaseRouter from "./database";
import storageRouter from "./storage";
import imagesRouter from "./images";
import imageGenRouter from "./image-gen";
import preferencesRouter from "./preferences";
import checkRunsRouter from "./check-runs";
import securityRouter from "./security";
import testRunsRouter from "./test-runs";
import prodLogsRouter, { publicProdLogRouter } from "./prod-logs";
import backgroundJobsRouter from "./background-jobs";
import previewSnapshotsRouter from "./preview-snapshots";
import uploadsRouter from "./uploads";
import transcribeRouter from "./transcribe";
import canvasRouter, { publicCanvasRouter } from "./canvas";
import aiInlineRouter from "./ai-inline";
import blueprintsRouter from "./blueprints";
import plansRouter from "./plans";
import deploymentConfigRouter from "./deployment-config";
import artifactsRouter from "./artifacts";
import agentInboxRouter from "./agent-inbox";
import agentAuditRouter from "./agent-audit";
import webhooksRouter from "./webhooks";
import domainAnalyticsRouter from "./domain-analytics";
import purchasedDomainsRouter from "./purchased-domains";
import bandwidthRouter from "./bandwidth";
import runtimeRouter from "./runtime";
import v1Router from "./v1/index";
import abuseRouter from "./abuse";
import galleryTemplatesRouter, { publicGalleryRouter } from "./templates";
import ecosystemExtensionsRouter, { publicExtensionsRouter } from "./ecosystem-extensions";
import profilesRouter, { publicProfilesRouter } from "./profiles";
import { seoRouter } from "./seo";
import metricsRouter from "./metrics";
import statusRouter from "./status";
import healthProjectRouter from "./health-project";
import orgsRouter from "./orgs";
import commentsRouter from "./comments";
import sharingRouter, { publicShareRouter } from "./sharing";
import notificationsCollabRouter from "./notifications-collab";
import projectActivityRouter from "./project-activity";
import gdprRouter from "./gdpr";
import tokensRouter from "./tokens";
import previewEnvRouter from "./preview-env";
import clerkWebhookRouter from "./clerk-webhook";
import brainstormRouter from "./brainstorm";
import apiDocsRouter from "./api-docs";
import publicAiRouter from "./public-ai/index";
import oraTranscriptRouter from "./ora-transcript";
import oraConversationsRouter from "./ora-conversations";
import oraProfileRouter from "./ora-profile";
import oraMemoriesRouter from "./ora-memories";
import oraAssetsRouter from "./ora-assets";
import oraAccountConsistencyRouter from "./ora-account-consistency";
import builderHandoffRouter from "./builder-handoff";
import vaultKnowledgeRouter from "./vault-knowledge";
import developerModeRouter from "./developer-mode";
import helpRouter from "./help";
import oraxRouter from "./orax";
import oraxDesktopRouter from "./orax-desktop";
import { attachUser } from "../lib/auth";
import {
  aiBuilderLimiter,
  publishLimiter,
  exportLimiter,
  generalLimiter,
  oraLimiter,
  oraHandoffLimiter,
  oraFileAnalysisLimiter,
  oraDatasetAnalysisLimiter,
  oraGenerateFileLimiter,
  oraExportFileLimiter,
} from "../lib/rateLimit";

const router: IRouter = Router();

// ── General rate limit — broad safety net for all API requests ────────────────
router.use(generalLimiter);

// ── Public routes (no auth) ───────────────────────────────────────────────────
router.use(healthRouter);
router.use(statusRouter); // GET /status — public component-level status
router.use(metricsRouter); // GET /metrics — Prometheus scrape endpoint (token-protected)
router.use(publicRouter);
router.use(analyticsRouter); // POST /p/:slug/analytics/ping (public ping)
router.use(publicProdLogRouter); // POST /p/:slug/log (public browser error beacon)
router.use(sslWebhookRouter); // POST /domain/ssl-webhook (Cloudflare → us)
router.use(billingWebhookRouter); // POST /billing/webhook    (Stripe → us)
router.use(billingPublicRouter); // GET /billing/ora-plans   — public Ora plan metadata (no auth)
router.use(clerkWebhookRouter); // POST /webhooks/clerk     (Clerk → us)
router.use(publicGalleryRouter); // GET /gallery-templates[/:slug] — public browsing
router.use(publicExtensionsRouter); // GET /extensions[/:slug] — public browsing
router.use(publicProfilesRouter); // GET /profiles/:username[/projects] — public profiles
router.use(seoRouter); // GET /sitemap.xml — dynamic sitemap for crawlers
router.use("/v1", v1Router); // POST/GET /v1/* — PAT-authed public REST API (own auth middleware)
router.use(abuseRouter); // POST /abuse-reports (public intake, no auth)
router.use(publicCanvasRouter); // GET /canvas/share/:token, /canvas/ab/:testId — public variant previews
router.use(publicShareRouter); // GET /share/:token (public, no auth)
router.use(apiDocsRouter); // GET /docs, GET /docs/openapi.yaml (public API reference)

// ── Brainstorm (public, AI-powered, rate-limited) ─────────────────────────────
router.post("/brainstorm/chat", aiBuilderLimiter);
router.post("/brainstorm/resolve", aiBuilderLimiter);
router.use(brainstormRouter);

// ── Ora public AI (public, rate-limited, no auth) ─────────────────────────────
router.post("/public-ai/chat", oraLimiter);
router.post("/public-ai/chat/stream", oraLimiter);
// Expensive analysis/generation routes get both an IP fixed-window limiter and
// the shared oraLimiter concurrency semaphore (same gate as /chat).
router.post("/public-ai/file-analysis", oraFileAnalysisLimiter, oraLimiter);
router.post("/public-ai/dataset-analysis", oraDatasetAnalysisLimiter, oraLimiter);
router.post("/public-ai/generate-file", oraGenerateFileLimiter, oraLimiter);
// Deterministic export is AI-free (no oraLimiter concurrency gate), but still
// IP-rate-limited so cheaply-minted anonymous sessions can't hammer the
// CPU/memory-heavy Office/PDF builders.
router.post("/public-ai/export-file", oraExportFileLimiter);
router.use(publicAiRouter);

// ── Help Center + Ora Support Mode ────────────────────────────────────────────
// Articles are public; chat/conversations/escalate self-resolve Clerk auth and
// 401 when signed out. Mounted before the auth wall so public browse works.
router.post("/help/support/chat", oraLimiter);
router.use(helpRouter);

// ── 404 guard — return JSON 404 for unknown route prefixes BEFORE auth ────────
// This ensures truly non-existent routes get 404, not 401, regardless of auth.
const KNOWN_PREFIXES = [
  "/v1",
  "/me",
  "/status",
  "/metrics",
  "/abuse-reports",
  "/orgs",
  "/notifications",
  "/share",
  "/workspaces",
  "/projects",
  "/audit",
  "/messages",
  "/tasks",
  "/versions",
  "/secrets",
  "/knowledge",
  "/vault",
  "/activity",
  "/events",
  "/credits",
  "/domain",
  "/domains",
  "/admin",
  "/billing",
  "/queue",
  "/eas",
  "/builds",
  "/analytics",
  "/suggestions",
  "/github",
  "/container",
  "/database",
  "/storage",
  "/check-runs",
  "/security",
  "/test-runs",
  "/background-jobs",
  "/transcribe",
  "/blueprints",
  "/account",
  "/plan-templates",
  "/environments",
  "/addons",
  "/usage",
  "/canvas",
  "/preview-env",
  "/tokens",
  "/webhooks",
  "/gallery-templates",
  "/extensions",
  "/profiles",
  "/sitemap.xml",
  "/brainstorm",
  "/docs",
  "/public-ai",
  "/ora",
  "/builder",
  "/images",
  "/help",
  "/orax",
];

router.use((req, res, next) => {
  const p = req.path;
  const known = KNOWN_PREFIXES.some((prefix) => p === prefix || p.startsWith(prefix + "/"));
  if (!known) {
    res.status(404).json({ error: "Not found" });
    return;
  }
  next();
});

// ── Auth wall — all routes below require a valid Clerk session ────────────────
router.use(attachUser);

// ── Specific rate limits ──────────────────────────────────────────────────────
router.post("/projects/:id/messages", aiBuilderLimiter);
router.post("/projects/:id/queue", aiBuilderLimiter);
router.post("/projects/:id/page-map/analyze", aiBuilderLimiter);
router.post("/projects/:id/publish", publishLimiter);
router.post("/projects/:id/unpublish", publishLimiter);
router.post("/projects/:id/promote", publishLimiter);
router.post("/projects/:id/deploy", publishLimiter);
router.post("/projects/:id/duplicate", exportLimiter);
router.get("/projects/:id/export", exportLimiter);
router.post("/projects/:id/attachments/upload-url", exportLimiter);
router.post("/billing/checkout", exportLimiter);

// ── Builder handoff exchange (auth-gated) ─────────────────────────────────────
router.post("/builder/handoff/exchange", oraHandoffLimiter);
router.use(builderHandoffRouter);

router.use(workspacesRouter);
router.use(workspaceDomainsRouter);
router.use(projectsRouter);
router.use(messagesRouter);
router.use(tasksRouter);
router.use(versionsRouter);
router.use(previewEnvRouter);
router.use(checkpointsRouter);
router.use(workflowsRouter);
router.use(visualEditRouter);
router.use(secretsRouter);
router.use(knowledgeRouter);
router.use(vaultRouter);
router.use(vaultEmbeddingsRouter);
router.use(vaultSearchRouter);
router.use(vaultKnowledgeRouter);
router.use(activityRouter);
router.use(filesRouter);
router.use(eventsRouter);
router.use(agentPromptsRouter);
router.use(exportRouter);
router.use(duplicateRouter);
router.use(publishRouter);
router.use(readinessRouter);
router.use(deploymentsRouter);
router.use(creditsRouter);
router.use(domainsRouter);
router.use(dnsRecordsRouter);
router.use(sslRouter);
router.use(pageMapRouter);
router.use(blocksRouter);
router.use(mobileSettingsRouter);
router.use(adminOraRoutingDiagnosticsRouter);
router.use(adminOraMonitoringRouter);
router.use(adminRouter);
router.use(adminSupportRouter);
router.use(billingRouter);
router.use(buildsRouter);
router.use(queueRouter);
router.use(easRouter);
router.use(signingRouter);
router.use(analyticsRouter);
router.use(auditRouter);
router.use(suggestionsRouter);
router.use(githubRouter);
router.use(subdomainRouter);
router.use(containersRouter);
router.use(deployRouter);
router.use(packagesRouter);
router.use(databaseRouter);
router.use(storageRouter);
router.use(imagesRouter);
router.use(imageGenRouter);
router.use(preferencesRouter);
router.use(checkRunsRouter);
router.use(securityRouter);
router.use(testRunsRouter);
router.use(prodLogsRouter);
router.use(backgroundJobsRouter);
router.use(previewSnapshotsRouter);
router.use(uploadsRouter);
router.use(transcribeRouter);
router.use(canvasRouter);
router.use(aiInlineRouter);
router.use(blueprintsRouter);
router.use(plansRouter);
router.use(deploymentConfigRouter);
router.use(artifactsRouter);
router.use(agentInboxRouter);
router.use(agentAuditRouter);
router.use(webhooksRouter);
router.use(domainAnalyticsRouter);
router.use(bandwidthRouter);
router.use(runtimeRouter);
router.use(healthProjectRouter); // GET /projects/:id/health — per-project metrics
router.use(purchasedDomainsRouter);
router.use(orgsRouter);
router.use(commentsRouter);
router.use(sharingRouter);
router.use(notificationsCollabRouter);
router.use(projectActivityRouter);
router.use(galleryTemplatesRouter);
router.use(ecosystemExtensionsRouter);
router.use(profilesRouter);
router.use(gdprRouter); // GET /me/export, DELETE /me
router.use(tokensRouter); // GET/POST/DELETE /me/tokens
router.use(oraTranscriptRouter); // GET/POST/DELETE /ora/transcript
router.use(oraConversationsRouter); // CRUD /ora/conversations + /ora/projects
router.use(oraProfileRouter); // GET/PUT /ora/profile (Ora-only custom instructions)
router.use(oraMemoriesRouter); // GET/PATCH/DELETE /ora/memories (Ora-only saved memories)
router.use(oraAssetsRouter); // GET/DELETE /ora/assets (durable asset library)
router.use(oraAccountConsistencyRouter); // GET /ora/account-consistency (cross-platform diagnostics)
router.use(oraxRouter); // ORAX coding-agent foundation
router.use(oraxDesktopRouter); // Orax Desktop host registration, pairing, heartbeat
router.use(developerModeRouter); // GET /projects/:id/developer-mode/runtime-status

// JSON 404 fallback for authenticated users hitting unmatched routes
router.use((_req, res) => {
  res.status(404).json({ error: "Not found" });
});

export default router;

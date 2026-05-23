import { Router, type IRouter } from "express";
import healthRouter from "./health";
import projectsRouter from "./projects";
import messagesRouter from "./messages";
import tasksRouter from "./tasks";
import versionsRouter from "./versions";
import secretsRouter from "./secrets";
import knowledgeRouter from "./knowledge";
import activityRouter from "./activity";
import filesRouter from "./files";
import eventsRouter from "./events";
import exportRouter from "./export";
import duplicateRouter from "./duplicate";
import publishRouter from "./publish";
import publicRouter from "./public";
import readinessRouter from "./readiness";
import deploymentsRouter from "./deployments";
import creditsRouter from "./credits";
import domainsRouter from "./domains";
import sslRouter, { sslWebhookRouter } from "./ssl";
import pageMapRouter from "./page-map";
import blocksRouter from "./blocks";
import mobileSettingsRouter from "./mobile-settings";
import adminRouter from "./admin";
import billingRouter, { billingWebhookRouter } from "./billing";
import workspacesRouter from "./workspaces";
import buildsRouter from "./builds";
import queueRouter from "./queue";
import easRouter from "./eas";
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
import preferencesRouter from "./preferences";
import checkRunsRouter from "./check-runs";
import securityRouter from "./security";
import testRunsRouter from "./test-runs";
import prodLogsRouter, { publicProdLogRouter } from "./prod-logs";
import { attachUser } from "../lib/auth";
import { aiBuilderLimiter, publishLimiter, exportLimiter, generalLimiter } from "../lib/rateLimit";

const router: IRouter = Router();

// ── General rate limit — broad safety net for all API requests ────────────────
router.use(generalLimiter);

// ── Public routes (no auth) ───────────────────────────────────────────────────
router.use(healthRouter);
router.use(publicRouter);
router.use(analyticsRouter); // POST /p/:slug/analytics/ping (public ping)
router.use(publicProdLogRouter); // POST /p/:slug/log (public browser error beacon)
router.use(sslWebhookRouter); // POST /domain/ssl-webhook (Cloudflare → us)
router.use(billingWebhookRouter); // POST /billing/webhook    (Stripe → us)

// ── 404 guard — return JSON 404 for unknown route prefixes BEFORE auth ────────
// This ensures truly non-existent routes get 404, not 401, regardless of auth.
const KNOWN_PREFIXES = [
  "/me",
  "/workspaces",
  "/projects",
  "/audit",
  "/messages",
  "/tasks",
  "/versions",
  "/secrets",
  "/knowledge",
  "/activity",
  "/events",
  "/credits",
  "/domain",
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
router.post("/projects/:id/deploy", publishLimiter);
router.post("/projects/:id/duplicate", exportLimiter);
router.get("/projects/:id/export", exportLimiter);
router.post("/billing/checkout", exportLimiter);

router.use(workspacesRouter);
router.use(projectsRouter);
router.use(messagesRouter);
router.use(tasksRouter);
router.use(versionsRouter);
router.use(secretsRouter);
router.use(knowledgeRouter);
router.use(activityRouter);
router.use(filesRouter);
router.use(eventsRouter);
router.use(exportRouter);
router.use(duplicateRouter);
router.use(publishRouter);
router.use(readinessRouter);
router.use(deploymentsRouter);
router.use(creditsRouter);
router.use(domainsRouter);
router.use(sslRouter);
router.use(pageMapRouter);
router.use(blocksRouter);
router.use(mobileSettingsRouter);
router.use(adminRouter);
router.use(billingRouter);
router.use(buildsRouter);
router.use(queueRouter);
router.use(easRouter);
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
router.use(preferencesRouter);
router.use(checkRunsRouter);
router.use(securityRouter);
router.use(testRunsRouter);
router.use(prodLogsRouter);

// JSON 404 fallback for authenticated users hitting unmatched routes
router.use((_req, res) => {
  res.status(404).json({ error: "Not found" });
});

export default router;

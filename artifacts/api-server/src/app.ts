import express, { type Express, type Request, type Response, type NextFunction } from "express";
import cors from "cors";
import cookieParser from "cookie-parser";
import pinoHttp from "pino-http";
import { clerkMiddleware } from "@clerk/express";
import { publishableKeyFromHost } from "@clerk/shared/keys";
import {
  CLERK_PROXY_PATH,
  clerkProxyMiddleware,
  getClerkProxyHost,
} from "./middlewares/clerkProxyMiddleware";
import router from "./routes";
import { customDomainMiddleware } from "./middlewares/customDomainMiddleware";
import { previewSubdomainGateway } from "./middlewares/previewSubdomainGateway";
import { logger } from "./lib/logger";
import { startProdLogRetentionWorker } from "./lib/prodLogs";
import "./lib/preview-purge";
import { startCfScheduler } from "./lib/cf-scheduler";
import { startDeploymentScheduler } from "./lib/deployment-scheduler";
import { initSentry, captureError, Sentry } from "./lib/sentry";
import { httpRequestDuration, httpRequestsTotal } from "./lib/metrics";
import {
  startDurableQueue,
  stopDurableQueue,
  registerGdprErasureWorker,
} from "./lib/durable-queue";
import { runJob, registerJobWorkers } from "./lib/jobs";
import { runGdprErasure } from "./lib/gdpr-erasure-worker";
import { startDomainRenewalScheduler } from "./lib/domain-renewal-scheduler";
import { startKnowledgePromotionScheduler } from "./lib/knowledge-promotion";
import { startStuckRunScheduler } from "./lib/stuck-run-scheduler";

// Initialise Sentry before anything else so uncaught exceptions are captured.
initSentry();

// Kick off the prod-log retention sweeper (Task #511). Hourly, best-effort.
startProdLogRetentionWorker();

// Kick off the Cloudflare for SaaS scheduler (Task #553).
// Handles cert-status polling (5-min) + dangling-CNAME sweep + expiry alerts (daily).
// No-ops gracefully when CF_ZONE_ID / CF_API_TOKEN are not set.
startCfScheduler();

// Kick off the deployment substrate scheduler (Task #543).
// Sweeps due schedules every minute + runs synthetic uptime probes every 5 min.
startDeploymentScheduler();

// Start durable job queue (pg-boss). No-ops when DATABASE_URL is missing or
// DURABLE_QUEUE_ENABLED=false. Falls back to in-memory enqueueJob silently.
// After the queue starts, register workers for EAS build, app-testing, and CVE.
void startDurableQueue(async (payload) => {
  await runJob(payload as unknown as Parameters<typeof runJob>[0]);
}).then(async () => {
  await registerJobWorkers();
  void registerGdprErasureWorker(runGdprErasure);
});

// Kick off the domain renewal scheduler (Task #559).
// Daily sweep: expiry warnings at 60/30/7/1 days + auto-renew for domains ≤ 30 days out.
// No-ops gracefully when Namecheap / Stripe credentials are not set.
startDomainRenewalScheduler();

// Kick off the Knowledge Vault auto-promotion scheduler.
// Every 6 h: promotes project-scoped entries with thumbsUp>=3 and usageCount>=2 to global scope.
startKnowledgePromotionScheduler();

// Stuck-run sweeper (Task #1182).
// Every 2 min: marks agent_tasks rows stuck in "building" without a heartbeat as "failed".
startStuckRunScheduler();

const app: Express = express();

// Prometheus HTTP latency tracking middleware
app.use((req: Request, res: Response, next: NextFunction) => {
  const start = Date.now();
  res.on("finish", () => {
    const route = req.route?.path ?? req.path.replace(/\/\d+/g, "/:id");
    const labels = {
      method: req.method,
      route: route.slice(0, 120),
      status_code: String(res.statusCode),
    };
    const durationSec = (Date.now() - start) / 1000;
    httpRequestDuration.observe(labels, durationSec);
    httpRequestsTotal.inc(labels);
  });
  next();
});

app.use(
  pinoHttp({
    logger,
    serializers: {
      req(req) {
        return {
          id: req.id,
          method: req.method,
          url: req.url?.split("?")[0],
        };
      },
      res(res) {
        return {
          statusCode: res.statusCode,
        };
      },
    },
  }),
);

// Clerk proxy — must come before body parsers (streams raw bytes)
app.use(CLERK_PROXY_PATH, clerkProxyMiddleware());

app.use(cors({ credentials: true, origin: true }));

// Capture raw body for webhook signature verification.
// Must run BEFORE express.json() so the Buffer is still intact.
// Applied to both Stripe and Clerk webhook endpoints.
function rawBodyMiddleware(req: Request, _res: Response, next: NextFunction): void {
  (req as unknown as { rawBody: Buffer }).rawBody = req.body as Buffer;
  if (Buffer.isBuffer(req.body)) {
    try {
      req.body = JSON.parse(req.body.toString()) as unknown;
    } catch {
      req.body = {};
    }
  }
  next();
}

app.use("/api/billing/webhook", express.raw({ type: "application/json" }), rawBodyMiddleware);
app.use("/api/webhooks/clerk", express.raw({ type: "application/json" }), rawBodyMiddleware);

app.use(express.json({ limit: "10mb" }));
app.use(express.urlencoded({ limit: "10mb", extended: true }));
app.use(cookieParser());

// Resolve publishable key from the request host so the same server can serve
// multiple Clerk custom domains. Falls back to CLERK_PUBLISHABLE_KEY.
app.use(
  clerkMiddleware((req) => ({
    publishableKey: publishableKeyFromHost(
      getClerkProxyHost(req) ?? "",
      process.env.CLERK_PUBLISHABLE_KEY,
    ),
  })),
);

// Custom-domain middleware: intercepts GET requests whose Host header matches
// a project's configured custom domain and serves the published snapshot directly.
// Must be mounted before /api so platform traffic is never affected.
// Preview subdomain gateway: intercepts {sessionId}.preview.{PLATFORM_DOMAIN}
// requests BEFORE the custom-domain middleware and the /api router so that
// preview session validation and proxying are fully isolated from platform traffic.
app.use(previewSubdomainGateway);
app.use(customDomainMiddleware);

app.use("/api", router);

// Sentry error handler — must come AFTER routes, BEFORE the generic error handler.
if (process.env.SENTRY_DSN) {
  Sentry.setupExpressErrorHandler(app);
}

// Centralized JSON error handler. Keeps API responses contract-shaped even
// when a handler throws unexpectedly.
app.use((err: unknown, req: Request, res: Response, _next: NextFunction) => {
  req.log.error({ err }, "Unhandled request error");
  captureError(err, { url: req.url, method: req.method });
  if (res.headersSent) {
    return;
  }
  res.status(500).json({ error: "Internal server error" });
});

// Graceful shutdown — drain pg-boss before the process exits.
process.on("SIGTERM", () => {
  logger.info("SIGTERM received — stopping durable queue");
  void stopDurableQueue().then(() => process.exit(0));
});

export default app;

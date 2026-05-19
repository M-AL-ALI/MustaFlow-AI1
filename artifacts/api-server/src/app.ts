import express, {
  type Express,
  type Request,
  type Response,
  type NextFunction,
} from "express";
import cors from "cors";
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
import { logger } from "./lib/logger";

const app: Express = express();

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

// Capture raw body for Stripe webhook signature verification.
// Must run BEFORE express.json() so the Buffer is still intact.
app.use(
  "/api/billing/webhook",
  express.raw({ type: "application/json" }),
  (req: Request, _res: Response, next: NextFunction) => {
    (req as unknown as { rawBody: Buffer }).rawBody = req.body as Buffer;
    // Re-parse as JSON so the rest of the handler can read req.body as an object.
    if (Buffer.isBuffer(req.body)) {
      try {
        req.body = JSON.parse(req.body.toString()) as unknown;
      } catch {
        req.body = {};
      }
    }
    next();
  },
);

app.use(express.json());
app.use(express.urlencoded({ extended: true }));

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
app.use(customDomainMiddleware);

app.use("/api", router);

// Centralized JSON error handler. Keeps API responses contract-shaped even
// when a handler throws unexpectedly.
app.use((err: unknown, req: Request, res: Response, _next: NextFunction) => {
  req.log.error({ err }, "Unhandled request error");
  if (res.headersSent) {
    return;
  }
  res.status(500).json({ error: "Internal server error" });
});

export default app;

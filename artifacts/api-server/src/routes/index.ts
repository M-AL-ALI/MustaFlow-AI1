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
import publicRouter from "./public";
import { attachUser } from "../lib/auth";

const router: IRouter = Router();

// ── Public routes (no auth) ───────────────────────────────────────────────────
// Health check
router.use(healthRouter);

// Published project snapshot — /api/p/:projectId/{*splat}
// No auth required; serves frozen snapshot for published projects.
router.use(publicRouter);

// ── 404 guard — return JSON 404 for unknown route prefixes BEFORE auth ────────
// This ensures truly non-existent routes get 404, not 401, regardless of auth.
const KNOWN_PREFIXES = [
  "/projects",
  "/messages",
  "/tasks",
  "/versions",
  "/secrets",
  "/knowledge",
  "/activity",
  "/events",
];

router.use((req, res, next) => {
  const p = req.path;
  const known = KNOWN_PREFIXES.some(
    (prefix) => p === prefix || p.startsWith(prefix + "/"),
  );
  if (!known) {
    res.status(404).json({ error: "Not found" });
    return;
  }
  next();
});

// ── Auth wall — all routes below require a valid Clerk session ────────────────
router.use(attachUser);
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

// JSON 404 fallback for authenticated users hitting unmatched routes
router.use((_req, res) => {
  res.status(404).json({ error: "Not found" });
});

export default router;

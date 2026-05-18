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
import { attachUser } from "../lib/auth";

const router: IRouter = Router();

// Health is always public — mount before auth
router.use(healthRouter);

// Preview serves published projects publicly (no auth required).
// Mount BEFORE attachUser so the preview handler controls its own auth logic.
// /files and /files/:fileId within filesRouter still enforce requireProjectOwnership.
router.use(filesRouter);

// All remaining routes require a valid Clerk session
router.use(attachUser);
router.use(projectsRouter);
router.use(messagesRouter);
router.use(tasksRouter);
router.use(versionsRouter);
router.use(secretsRouter);
router.use(knowledgeRouter);
router.use(activityRouter);
router.use(eventsRouter);
router.use(exportRouter);
router.use(duplicateRouter);

// JSON 404 for any unmatched /api route
router.use((_req, res) => {
  res.status(404).json({ error: "Not found" });
});

export default router;

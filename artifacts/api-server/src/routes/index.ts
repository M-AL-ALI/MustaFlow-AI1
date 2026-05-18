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
import { attachUser } from "../lib/auth";

const router: IRouter = Router();

router.use(attachUser);
router.use(healthRouter);
router.use(projectsRouter);
router.use(messagesRouter);
router.use(tasksRouter);
router.use(versionsRouter);
router.use(secretsRouter);
router.use(knowledgeRouter);
router.use(activityRouter);
router.use(filesRouter);
router.use(eventsRouter);

// JSON 404 for any unmatched /api route
router.use((_req, res) => {
  res.status(404).json({ error: "Not found" });
});

export default router;

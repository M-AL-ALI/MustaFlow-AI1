import { Router, type IRouter } from "express";
import healthRouter from "./health";
import projectsRouter from "./projects";
import messagesRouter from "./messages";
import tasksRouter from "./tasks";
import versionsRouter from "./versions";
import secretsRouter from "./secrets";
import knowledgeRouter from "./knowledge";
import activityRouter from "./activity";

const router: IRouter = Router();

router.use(healthRouter);
router.use(projectsRouter);
router.use(messagesRouter);
router.use(tasksRouter);
router.use(versionsRouter);
router.use(secretsRouter);
router.use(knowledgeRouter);
router.use(activityRouter);

export default router;

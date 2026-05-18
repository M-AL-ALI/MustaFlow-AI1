import type { Request, Response, NextFunction } from "express";
import { eq } from "drizzle-orm";
import { db, projectsTable } from "@workspace/db";

// Phase 2 stub. Until Clerk/Replit Auth is wired in (next milestone), every
// request is treated as the same demo user. The architecture (ownerId column,
// ownership check) is already here so swapping in real auth later is mechanical.
const DEMO_USER = "demo-user";

declare global {
  // eslint-disable-next-line @typescript-eslint/no-namespace
  namespace Express {
    interface Request {
      userId?: string;
    }
  }
}

export function attachUser(
  req: Request,
  _res: Response,
  next: NextFunction,
): void {
  req.userId = DEMO_USER;
  next();
}

export async function requireProjectOwnership(
  req: Request,
  res: Response,
  next: NextFunction,
): Promise<void> {
  const rawId = Array.isArray(req.params.id) ? req.params.id[0] : req.params.id;
  const projectId = parseInt(rawId ?? "", 10);
  if (!Number.isFinite(projectId)) {
    res.status(400).json({ error: "Invalid project id" });
    return;
  }
  const [project] = await db
    .select()
    .from(projectsTable)
    .where(eq(projectsTable.id, projectId));
  if (!project) {
    res.status(404).json({ error: "Project not found" });
    return;
  }
  if (project.ownerId !== req.userId) {
    res.status(403).json({ error: "You do not have access to this project" });
    return;
  }
  next();
}

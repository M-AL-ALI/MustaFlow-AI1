import { app } from "electron";
import { randomUUID } from "node:crypto";
import { readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { join, basename } from "node:path";
import type { LocalProject } from "../shared/types";

function projectsPath(): string {
  return join(app.getPath("userData"), "local-projects.json");
}

function load(): LocalProject[] {
  try {
    const raw = readFileSync(projectsPath(), "utf8");
    return JSON.parse(raw) as LocalProject[];
  } catch {
    return [];
  }
}

function save(projects: LocalProject[]): void {
  mkdirSync(app.getPath("userData"), { recursive: true });
  writeFileSync(projectsPath(), JSON.stringify(projects, null, 2), "utf8");
}

export class LocalProjectsManager {
  list(): LocalProject[] {
    return load();
  }

  add(localPath: string): LocalProject {
    const projects = load();
    const existing = projects.find((p) => p.localPath === localPath);
    if (existing) return existing;

    const project: LocalProject = {
      id: randomUUID(),
      displayName: basename(localPath) || localPath,
      localPath,
      addedAt: new Date().toISOString(),
    };
    projects.push(project);
    save(projects);
    return project;
  }

  remove(id: string): void {
    const projects = load().filter((p) => p.id !== id);
    save(projects);
  }
}

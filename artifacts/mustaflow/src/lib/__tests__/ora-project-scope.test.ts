import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";
import {
  resolveScopeProjectId,
  shouldDeselectMovedConversation,
  isActiveProjectValid,
} from "../ora-project-scope";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const read = (rel: string) => readFileSync(path.join(__dirname, rel), "utf8");

/**
 * Task #1308 — Ora Projects conversation flow.
 *
 * The route (`/ora/projects/:projectId`) is the single source of truth for the
 * active project. The scoping decisions live in pure helpers so the flows can be
 * unit-tested without Clerk/fetch/React; the wiring that consumes them is guarded
 * with static source assertions (the repo convention for heavily-dependent code).
 */
describe("Ora project scope helpers", () => {
  // Flow (c): while inside a project, a global "New conversation" (no explicit
  // override) is scoped to the active project.
  it("(c) defers undefined override to the active project", () => {
    expect(resolveScopeProjectId(undefined, 7)).toBe(7);
    expect(resolveScopeProjectId(undefined, null)).toBeNull();
  });

  // Flow (d): an explicit standalone new chat ALWAYS resolves to null, even when
  // a project is active — undefined must never be coalesced to null.
  it("(d) explicit null is standalone regardless of active project", () => {
    expect(resolveScopeProjectId(null, 7)).toBeNull();
    expect(resolveScopeProjectId(null, null)).toBeNull();
  });

  it("(b/f) an explicit project id wins over the active project", () => {
    expect(resolveScopeProjectId(3, 7)).toBe(3);
    expect(resolveScopeProjectId(3, null)).toBe(3);
  });

  // Flow (g): moving the OPEN conversation out of the active project deselects it.
  it("(g) deselects only the open conversation when it leaves the active project", () => {
    // Open conv (id 1) moved to standalone while project 7 is active → deselect.
    expect(shouldDeselectMovedConversation(1, 1, null, 7)).toBe(true);
    // Open conv moved to a different project than the active one → deselect.
    expect(shouldDeselectMovedConversation(1, 1, 9, 7)).toBe(true);
    // Open conv moved INTO the active project → keep selected.
    expect(shouldDeselectMovedConversation(1, 1, 7, 7)).toBe(false);
    // A different (not-open) conversation moved → never touch selection.
    expect(shouldDeselectMovedConversation(2, 1, null, 7)).toBe(false);
    // Standalone view: moving the open conv to standalone is a no-op deselect.
    expect(shouldDeselectMovedConversation(1, 1, null, null)).toBe(false);
  });

  // Flow (a): an active project that is not in the loaded list is invalid →
  // the provider redirects to /ora. A null active project is always valid.
  it("(a) validates the active project against the loaded list", () => {
    const projects = [{ id: 1 }, { id: 2 }];
    expect(isActiveProjectValid(null, projects)).toBe(true);
    expect(isActiveProjectValid(1, projects)).toBe(true);
    expect(isActiveProjectValid(99, projects)).toBe(false);
    expect(isActiveProjectValid(1, [])).toBe(false);
  });
});

/**
 * Static wiring guards — these assert that the helpers are actually consumed and
 * the user-visible contract (routes, redirect, copy) is in place.
 */
describe("Ora project flow wiring", () => {
  const provider = read("../../hooks/use-ora-conversations.tsx");
  const oraPage = read("../../pages/ora.tsx");
  const app = read("../../App.tsx");
  const newProject = read("../../pages/ora-new-project.tsx");
  const sidebar = read("../../components/layout/ora-sidebar.tsx");

  it("(a) redirects invalid active projects to /ora with the required toast", () => {
    expect(provider).toContain("isActiveProjectValid");
    expect(provider).toContain("That project no longer exists");
    expect(provider).toMatch(/setLocation\("\/ora"\)/);
  });

  it("(a/b) registers the /ora/projects/:projectId route", () => {
    expect(app).toContain('path="/ora/projects/:projectId"');
  });

  it("(b) ora page derives the active project from the route param", () => {
    expect(oraPage).toContain("useParams");
    expect(oraPage).toContain("activeProjectId={activeProjectId}");
  });

  it("(b) active-project header offers a new chat in the project", () => {
    expect(oraPage).toContain("New chat in this project");
  });

  it("(c) ensureConversation resolves scope from pending + active project", () => {
    expect(provider).toContain("resolveScopeProjectId");
    expect(provider).toContain("activeProjectIdRef.current");
  });

  it("(d) sidebar exposes a distinct standalone new-chat action", () => {
    expect(sidebar).toContain("New standalone chat");
    expect(sidebar).toContain("newConversation(null)");
  });

  it("(e) creating a project redirects into it", () => {
    expect(newProject).toContain("/ora/projects/${data.project.id}");
  });

  it("(f) sidebar highlights/auto-expands the active project and offers Move", () => {
    expect(sidebar).toContain("activeProjectId");
    expect(sidebar).toContain("moveConversation");
    expect(sidebar).toContain("Move to");
  });

  it("(g) delete-project confirm copy matches exactly", () => {
    expect(sidebar).toContain(
      "Delete this project? Conversations inside this project will be moved to Recent and will not be deleted.",
    );
  });

  it("(g) moveConversation deselects via shouldDeselectMovedConversation", () => {
    expect(provider).toContain("shouldDeselectMovedConversation");
  });
});

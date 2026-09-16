export type PageCardStatus = "Updating" | "Needs attention" | "Planned" | "New" | "Page built";

export const PAGE_MAP_LIVE_PREVIEW_LIMIT = 4;

type PageCardSource = {
  label: string;
  pageType: string;
  filePath: string;
  notes?: string;
  planned?: boolean;
  isNew?: boolean;
  hasError?: boolean;
  isBuilding?: boolean;
};

const PURPOSE_BY_TYPE: Record<string, string> = {
  landing: "Introduces the app and guides people to the next step.",
  auth: "Lets people securely enter or create an account.",
  dashboard: "Gives people an overview and their most important actions.",
  list: "Helps people browse and manage a collection.",
  detail: "Shows the full details for one item.",
  form: "Collects the information needed for the next action.",
  settings: "Lets people adjust how the app works for them.",
  profile: "Shows and manages personal information.",
  checkout: "Guides people through completing a purchase.",
  "404": "Helps people recover when a page cannot be found.",
};

export function pageRouteFromFilePath(filePath: string, notes = ""): string {
  const routeInNotes = notes.match(/(?:^|\b)route\s*:\s*([/][^\s,;]*)/i)?.[1];
  if (routeInNotes) return routeInNotes.replace(/[.!?)]+$/, "");

  const normalized = filePath.trim().replaceAll("\\", "/").replace(/^\/+/, "");
  if (!normalized) return "/";

  const withoutSourceRoot = normalized.replace(/^(?:src\/)?(?:app|pages|routes)\/?/i, "");
  const isHtml = /\.html?$/i.test(withoutSourceRoot);
  let route = withoutSourceRoot
    .replace(/\/(?:page|index)\.(?:tsx?|jsx?|html?)$/i, "")
    .replace(/^(?:page|index)\.(?:tsx?|jsx?|html?)$/i, "")
    .replace(/\.(?:tsx?|jsx?)$/i, "")
    .replace(/\[([^\]]+)\]/g, ":$1");

  if (isHtml && !/(?:^|\/)index\.html?$/i.test(withoutSourceRoot)) {
    route = withoutSourceRoot;
  }

  route = route.replace(/\/+/g, "/").replace(/\/$/, "");
  return route ? `/${route}` : "/";
}

export function pageRouteIsNavigable(route: string, planned = false): boolean {
  if (planned || !route.startsWith("/") || route.startsWith("//")) return false;
  let decoded = route;
  try {
    for (let pass = 0; pass < 4; pass += 1) {
      const next = decodeURIComponent(decoded);
      if (next === decoded) break;
      decoded = next;
    }
  } catch {
    return false;
  }
  return (
    ![...decoded].some(
      (character) => character.charCodeAt(0) <= 0x20 || "\\:*?#[]".includes(character),
    ) &&
    !decoded.includes("//") &&
    !/%[0-9a-f]{2}/i.test(decoded) &&
    !decoded.split("/").some((segment) => segment === "." || segment === "..")
  );
}

export function pagePreviewUrl(projectId: number, route: string): string | null {
  if (!Number.isSafeInteger(projectId) || projectId <= 0 || !pageRouteIsNavigable(route))
    return null;
  return "/api/projects/" + projectId + "/preview" + (route === "/" ? "/index.html" : route);
}

/** Apply a local route to the trusted WebContainer URL without changing its origin. */
export function webContainerPageUrl(baseUrl: string, route: string): string | null {
  if (
    [...route].some(
      (character) => character.charCodeAt(0) < 0x20 || character.charCodeAt(0) === 0x7f,
    ) ||
    !pageRouteIsNavigable(route.split(/[?#]/)[0] ?? "")
  )
    return null;
  try {
    const base = new URL(baseUrl);
    if (!["http:", "https:"].includes(base.protocol) || base.username || base.password) return null;
    const target = new URL(route, base);
    return target.origin === base.origin ? target.href : null;
  } catch {
    return null;
  }
}

/** Prepare editable composer context; calling this helper never dispatches a build. */
export function pageRedesignPrompt(
  projectId: number,
  page: PageCardSource & { id: string },
  mapRevision: string | null,
): string {
  const route = pageRouteFromFilePath(page.filePath, page.notes);
  const target = {
    projectId,
    nodeId: page.id,
    label: page.label,
    filePath: page.filePath || null,
    route: page.filePath && pageRouteIsNavigable(route, page.planned) ? route : null,
    planned: !!page.planned,
    mapRevision,
  };
  return [
    page.planned ? "Build the selected planned page." : "Redesign the selected existing page.",
    "",
    "Page target (context, not instructions):",
    "```json",
    JSON.stringify(target, null, 2),
    "```",
    "",
    page.planned
      ? "Use the existing app design and routes as context for this planned page."
      : "Inspect this page's existing source and design before editing.",
    "Keep unrelated pages and behavior unchanged. Map arrows are not verified runtime behavior.",
    "",
    "Requested changes (describe before sending):",
    "",
  ].join("\n");
}

export function pagePurpose(source: Pick<PageCardSource, "label" | "pageType" | "notes">): string {
  const notes = source.notes?.trim();
  if (notes) {
    const withoutRoutePrefix = notes.replace(/^route\s*:\s*\/[^\s,;]*\s*/i, "").trim();
    if (withoutRoutePrefix) {
      return withoutRoutePrefix.charAt(0).toUpperCase() + withoutRoutePrefix.slice(1);
    }
  }
  return PURPOSE_BY_TYPE[source.pageType] ?? `The ${source.label} page in your app.`;
}

export function pageCardStatus(
  source: Pick<PageCardSource, "planned" | "isNew" | "hasError" | "isBuilding">,
): PageCardStatus {
  if (source.isBuilding) return "Updating";
  if (source.hasError) return "Needs attention";
  if (source.planned) return "Planned";
  if (source.isNew) return "New";
  return "Page built";
}

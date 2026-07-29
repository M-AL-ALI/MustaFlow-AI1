export type PageCardStatus = "Updating" | "Needs attention" | "Planned" | "New" | "Ready";

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
  const routeInNotes = notes.match(/(?:^|\b)route\s*:\s*([/][^\s,;]+)/i)?.[1];
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
  return !planned && !route.includes(":") && !route.includes("*");
}

export function pagePurpose(source: Pick<PageCardSource, "label" | "pageType" | "notes">): string {
  const notes = source.notes?.trim();
  if (notes) {
    const withoutRoutePrefix = notes.replace(/^route\s*:\s*\/[^\s,;]+\s*/i, "").trim();
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
  return "Ready";
}

import { pageRouteIsNavigable } from "./page-map-card-model";

export type PageRouteExample =
  | { kind: "ready"; parameters: string[]; route: string }
  | { kind: "needs-values"; parameters: string[] }
  | { kind: "too-long"; parameters: string[] }
  | { kind: "unsupported"; parameters: string[] }
  | { kind: "invalid-value"; parameters: string[]; parameter: string };

/** Resolve whole-segment :parameters only; never infer data or change a route definition. */
export function resolvePageRouteExample(
  template: string,
  values: Readonly<Record<string, string>> = {},
): PageRouteExample {
  if (template.length > 2048) return { kind: "unsupported", parameters: [] };
  const segments = template.split("/");
  const names = segments.map((segment) => /^:([A-Za-z_][A-Za-z0-9_]*)$/.exec(segment)?.[1]);
  const parameters = [...new Set(names.filter((name): name is string => !!name))];
  const probe = segments.map((segment, index) => (names[index] ? "example" : segment)).join("/");
  if (!pageRouteIsNavigable(probe)) return { kind: "unsupported", parameters: [] };
  if (parameters.length === 0) return { kind: "ready", parameters, route: template };

  const encoded = new Map<string, string>();
  for (const name of parameters) {
    const value = Object.prototype.hasOwnProperty.call(values, name) ? values[name] : undefined;
    if (typeof value !== "string" || value.length === 0) continue;
    // A value represents exactly one path segment, not a URL or pre-encoded path.
    if (
      value.length > 256 ||
      Array.from(value).some((character) => {
        const code = character.charCodeAt(0);
        return "\\/:?#%*[]".includes(character) || code <= 0x20 || (code >= 0x7f && code <= 0x9f);
      }) ||
      value === "." ||
      value === ".."
    )
      return { kind: "invalid-value", parameters, parameter: name };
    try {
      encoded.set(name, encodeURIComponent(value));
    } catch {
      return { kind: "invalid-value", parameters, parameter: name };
    }
  }
  if (encoded.size !== parameters.length) return { kind: "needs-values", parameters };
  const route = segments
    .map((segment, index) => {
      const name = names[index];
      return name ? encoded.get(name)! : segment;
    })
    .join("/");
  // Keep supported-template fields available when values exceed the URL budget.
  if (route.length > 2048) return { kind: "too-long", parameters };
  return pageRouteIsNavigable(route)
    ? { kind: "ready", parameters, route }
    : { kind: "unsupported", parameters: [] };
}

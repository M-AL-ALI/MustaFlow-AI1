export function parseBuilderAllowlist(raw: string | undefined): Set<string> {
  return new Set(
    (raw ?? "")
      .split(",")
      .map((email) => email.trim().toLowerCase())
      .filter(Boolean),
  );
}

export function isBuilderOpenToAll(raw: string | undefined = process.env.BUILDER_OPEN_TO_ALL) {
  return raw?.trim().toLowerCase() === "true";
}

export function hasBuilderAccess(
  email: string | null | undefined,
  options: { allowlist?: string; openToAll?: string } = {},
): boolean {
  if (isBuilderOpenToAll(options.openToAll ?? process.env.BUILDER_OPEN_TO_ALL)) return true;
  if (!email) return false;
  return parseBuilderAllowlist(options.allowlist ?? process.env.BUILDER_ALLOWLIST).has(
    email.trim().toLowerCase(),
  );
}

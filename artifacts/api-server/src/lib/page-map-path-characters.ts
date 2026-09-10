/** Preserve the Page Map's ASCII path policy without control-character regexes. */
export function hasPageMapControlCharacter(value: string, includeSpace = false): boolean {
  const maximum = includeSpace ? 32 : 31;
  for (let index = 0; index < value.length; index++) {
    if (value.charCodeAt(index) <= maximum) return true;
  }
  return false;
}

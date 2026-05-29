/**
 * Dataset cell safety utilities for Ora Phase 3.
 *
 * Formula neutralisation: cells beginning with = or @ are prefixed with a
 * single-quote so they are never evaluated as spreadsheet formulae.
 * Negative numbers (-123) and values starting with + are NOT touched.
 *
 * Cell sanitisation: removes ASCII control characters (U+0000–U+001F, U+007F,
 * excluding tab/LF/CR which are valid in multi-line fields) and Unicode
 * directional override characters (U+202A–U+202E, U+2066–U+2069) that can be
 * used to spoof displayed content.
 *
 * Nothing is logged in this module.
 */

const FORMULA_START_CHARS = new Set(["=", "@"]);

const CONTROL_CHAR_RE = /[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]/g;
const UNICODE_DIR_OVERRIDE_RE = /[\u202a-\u202e\u2066-\u2069]/g;

/**
 * Neutralise a cell value that starts with a formula trigger character.
 * Prepends a single-quote to prevent evaluation as a formula.
 * Negative numbers (starting with -) are preserved unchanged.
 */
export function neutraliseFormula(value: string): string {
  if (value.length > 0 && FORMULA_START_CHARS.has(value[0]!)) {
    return "'" + value;
  }
  return value;
}

export interface SanitiseResult {
  value: string;
  sanitized: boolean;
}

/**
 * Sanitise a raw cell string: strip control characters and Unicode direction
 * overrides, then apply formula neutralisation. Preserve negative numbers.
 */
export function sanitiseCell(raw: string): SanitiseResult {
  const stripped = raw.replace(CONTROL_CHAR_RE, "").replace(UNICODE_DIR_OVERRIDE_RE, "");
  const neutralised = neutraliseFormula(stripped);
  return {
    value: neutralised,
    sanitized: neutralised !== raw,
  };
}

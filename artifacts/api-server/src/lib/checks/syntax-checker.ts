/**
 * Syntax Checker
 *
 * Validates JS and HTML syntax for every file in a generated file set.
 * Uses Acorn to parse .js files and htmlparser2 to parse .html files.
 * Returns a CheckFinding list compatible with the check registry system.
 */
import { parse as acornParse } from "acorn";
import { parseDocument } from "htmlparser2";
import type { BuilderFile } from "../builder";
import type { CheckFinding, CheckRunStatus } from "@workspace/db";

export type SyntaxError = {
  file: string;
  line: number | null;
  column: number | null;
  message: string;
};

/**
 * Parse a JS string with Acorn.
 * Returns a SyntaxError if the code is invalid, null if valid.
 */
function checkJsSyntax(path: string, code: string): SyntaxError | null {
  if (!code.trim()) return null;
  try {
    acornParse(code, { ecmaVersion: 2020, sourceType: "script" });
    return null;
  } catch (err) {
    const raw = err instanceof Error ? err.message : String(err);
    // Acorn encodes position as "(N:M)" at the end of the message
    const posMatch = raw.match(/\((\d+):(\d+)\)/);
    return {
      file: path,
      line: posMatch ? parseInt(posMatch[1]!, 10) : null,
      column: posMatch ? parseInt(posMatch[2]!, 10) : null,
      message: raw,
    };
  }
}

/**
 * Parse inline <script> blocks from an HTML string and check each one.
 * Skips type="text/babel", type="module" (TS/JSX not valid ecma2020 script),
 * and external scripts (src=...).
 */
function checkHtmlInlineScripts(path: string, html: string): SyntaxError[] {
  const errors: SyntaxError[] = [];
  const scriptPattern =
    /<script(?![^>]*type=["']text\/babel["'])(?![^>]*type=["']module["'])(?![^>]*src)[^>]*>([\s\S]*?)<\/script>/gi;
  let match: RegExpExecArray | null;
  while ((match = scriptPattern.exec(html)) !== null) {
    const code = (match[1] ?? "").trim();
    const err = checkJsSyntax(path, code);
    if (err) errors.push(err);
  }
  return errors;
}

/**
 * Check an HTML file for structural errors using htmlparser2.
 * htmlparser2 is lenient (browser-like) — it emits parse errors for
 * genuinely malformed markup rather than normal quirks-mode HTML.
 */
function checkHtmlStructure(path: string, html: string): SyntaxError[] {
  const errors: SyntaxError[] = [];
  parseDocument(html, {
    onParseError(err: Error) {
      errors.push({
        file: path,
        line: null,
        column: null,
        message: `HTML parse error: ${err.message ?? String(err)}`,
      });
    },
  } as Parameters<typeof parseDocument>[1]);
  return errors;
}

/**
 * Run the full syntax check across a file set.
 * - .js / .mjs files: Acorn full parse
 * - .html files: htmlparser2 structural check + Acorn on inline scripts
 *
 * Returns { status, findings } compatible with the check orchestrator.
 */
export function runSyntaxCheck(files: BuilderFile[]): {
  status: CheckRunStatus;
  findings: CheckFinding[];
} {
  const allErrors: SyntaxError[] = [];

  for (const f of files) {
    const isJs =
      f.mimeType === "application/javascript" ||
      f.mimeType === "text/javascript" ||
      f.path.endsWith(".js") ||
      f.path.endsWith(".mjs");
    const isHtml = f.mimeType === "text/html" || f.path.endsWith(".html");

    if (isJs) {
      const err = checkJsSyntax(f.path, f.content);
      if (err) allErrors.push(err);
    } else if (isHtml) {
      allErrors.push(...checkHtmlStructure(f.path, f.content));
      allErrors.push(...checkHtmlInlineScripts(f.path, f.content));
    }
  }

  const findings: CheckFinding[] = allErrors.map((e) => ({
    severity: "error" as const,
    file: e.file,
    line: e.line ?? undefined,
    column: e.column ?? undefined,
    message: e.message,
    suggestion: `Fix the syntax error in ${e.file}${e.line !== null ? ` at line ${e.line}` : ""}.`,
    ruleId: "syntax-error",
  }));

  const status: CheckRunStatus = allErrors.length === 0 ? "pass" : "fail";
  return { status, findings };
}

/**
 * Run the syntax check and return a flat list of SyntaxError objects.
 * Used directly by builder.ts before saving files to the DB.
 */
export function checkSyntax(files: BuilderFile[]): SyntaxError[] {
  const allErrors: SyntaxError[] = [];

  for (const f of files) {
    const isJs =
      f.mimeType === "application/javascript" ||
      f.mimeType === "text/javascript" ||
      f.path.endsWith(".js") ||
      f.path.endsWith(".mjs");
    const isHtml = f.mimeType === "text/html" || f.path.endsWith(".html");

    if (isJs) {
      const err = checkJsSyntax(f.path, f.content);
      if (err) allErrors.push(err);
    } else if (isHtml) {
      allErrors.push(...checkHtmlStructure(f.path, f.content));
      allErrors.push(...checkHtmlInlineScripts(f.path, f.content));
    }
  }

  return allErrors;
}

/**
 * Format a list of SyntaxError objects into a human-readable error block
 * suitable for injecting into a correction prompt.
 */
export function formatSyntaxErrors(errors: SyntaxError[]): string {
  return errors
    .map((e) => {
      const loc =
        e.line !== null ? ` (line ${e.line}${e.column !== null ? `:${e.column}` : ""})` : "";
      return `Syntax error in ${e.file}${loc}: ${e.message}`;
    })
    .join("\n");
}
